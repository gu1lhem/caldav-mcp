// ── caldav-mcp: CalDAV MCP Server ──
// Entry point. Parses args, initializes engine, starts stdio or HTTP transport.

import { type Env, loadEnv } from './env.ts'
import { createCalDavClient } from '@spy4x/caldav'
import { type EngineOptions, QueryEngine } from './caldav/query.ts'
import { type JsonRpcResponse, McpHandler, SUPPORTED_PROTOCOL_VERSIONS } from './mcp.ts'
import { MCP_PATH, type OAuth, openOAuth } from './oauth.ts'
import { runGrantsCommand } from './grants.ts'
import { readListsFile, runListsCommand } from './lists.ts'
import { AUTHORIZE_PATH } from '@spy4x/server/mcp-oauth'
import { registerAllTools } from './tools/index.ts'
import {
  bearerTokenFromHeaders,
  createTokenVerifier,
  formatLogLine,
} from '@spy4x/server/http/bearer-auth'
import { createMemoryRateLimiter } from '@spy4x/platform/rate-limit/memory'
import { clientIp, clientIpBucket } from '@spy4x/platform/rate-limit/client-ip'
import { uuidV7 } from '@spy4x/platform/universal/uuid'
import {
  BodyReadTimeoutError,
  PayloadTooLargeError,
  readBoundedText,
} from '@spy4x/net/bounded-body'

export const VERSION = '1.6.0'

async function main(): Promise<void> {
  // `caldav-mcp grants …` manages OAuth grants and exits; it needs no CalDAV settings.
  if (Deno.args[0] === 'grants') Deno.exit(await runGrantsCommand(Deno.args.slice(1)))

  // `caldav-mcp lists …` edits the named calendar lists and exits; it needs the CalDAV settings.
  if (Deno.args[0] === 'lists') {
    const env = loadEnv()
    const client = createCalDavClient({
      serverUrl: env.caldavUrl,
      auth: { username: env.caldavUsername, password: env.caldavPassword },
    })
    Deno.exit(
      await runListsCommand(
        Deno.args.slice(1),
        env.listsPath,
        new QueryEngine(client, engineOptions(env)),
      ),
    )
  }

  const env = loadEnv()
  const log = createLogger(env, (line) => console.error(line))

  log('info', `caldav-mcp v${VERSION} starting...`)
  log('info', `CalDAV server: ${env.caldavUrl}`)

  // Initialize
  const client = createCalDavClient({
    serverUrl: env.caldavUrl,
    auth: { username: env.caldavUsername, password: env.caldavPassword },
  })
  const engine = new QueryEngine(client, {
    ...engineOptions(env),
    // The lists are re-read on every call, so the CLI's edits apply without a restart.
    lists: () => readListsFile(env.listsPath),
  })
  log('info', `Time zone: ${engine.zone}`)

  const mcp = new McpHandler({ name: 'caldav-mcp', version: VERSION })
  registerAllTools(mcp, engine, env.tools)
  if (env.tools !== 'all') log('info', `Tools: ${env.tools}`)

  // Determine transport
  const args = Deno.args
  const useHttp = args.includes('--http') || args.includes('-h') || !!env.mcpBearerToken ||
    !!env.oauth

  if (useHttp) {
    await startHttp(mcp, env, log)
  } else {
    await startStdio(mcp, log)
  }
}

type Log = (level: string, msg: string) => void

/**
 * Build the logger: drops lines below `LOG_LEVEL` and redacts the bearer token and the CalDAV
 * password from every line it writes, so no code path can log either by accident.
 */
export function createLogger(
  env: Pick<Env, 'logLevel' | 'mcpBearerToken' | 'caldavPassword' | 'oauth'>,
  write: (line: string) => void,
): Log {
  const levels = ['debug', 'info', 'warn', 'error']
  const secrets = [
    env.mcpBearerToken,
    env.caldavPassword,
    env.oauth?.ownerPasswordHash,
    env.oauth?.authPepper,
  ]
  return (level, msg) => {
    if (levels.indexOf(level) >= levels.indexOf(env.logLevel)) {
      write(formatLogLine(level, msg, secrets))
    }
  }
}

// ── stdio transport (default) ──
async function startStdio(
  mcp: McpHandler,
  log: (level: string, msg: string) => void,
): Promise<void> {
  log('info', 'Starting stdio transport...')
  log('info', 'Ready — waiting for MCP messages on stdin')

  const decoder = new TextDecoder()
  const buf = new Uint8Array(65536)
  let buffer = ''

  // Read stdin continuously
  while (true) {
    const n = Deno.stdin.readSync(buf)
    if (n === null) break // EOF
    buffer += decoder.decode(buf.subarray(0, n), { stream: true })

    // Process complete messages (newline-delimited JSON)
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (!line) continue

      try {
        const response = await mcp.handleMessage(line)
        if (response) {
          const out = JSON.stringify(response) + '\n'
          Deno.stdout.writeSync(new TextEncoder().encode(out))
        }
      } catch (err) {
        log('error', `Failed to handle message: ${err}`)
      }
    }
  }
}

// ── HTTP transport (optional, for OpenWebUI/n8n via mcpo) ──

/** Requests each client may make per minute. */
const RATE_LIMIT = 100
/** Wrong tokens each client may send per minute before it gets 429. */
export const AUTH_FAILURE_LIMIT = 10
/**
 * Consent pages each client may open per minute. Each one may fetch the client's metadata document
 * and stores a pending consent, so it gets a tighter budget than other requests.
 */
export const CONSENT_PAGE_LIMIT = 10
/** Most clients the limiter tracks at once, so a flood of addresses cannot grow memory unbounded. */
const RATE_LIMIT_MAX_CLIENTS = 10_000
/** Largest `POST /mcp` body accepted. One JSON-RPC message is a few kilobytes at most. */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * Where the HTTP transport listens. Refuses to start without `MCP_BEARER_TOKEN` or OAuth, because
 * the server holds CalDAV credentials and an open port would hand them to anyone who can reach it.
 */
export function httpListenOptions(
  env: Pick<Env, 'host' | 'port' | 'mcpBearerToken' | 'oauth'>,
): { hostname: string; port: number; token: string | undefined } {
  if (!env.mcpBearerToken && !env.oauth) {
    throw new Error('MCP_BEARER_TOKEN or the OAuth env vars are required for HTTP mode')
  }
  return { hostname: env.host, port: env.port, token: env.mcpBearerToken }
}

async function startHttp(mcp: McpHandler, env: Env, log: Log): Promise<void> {
  const { hostname, port, token } = httpListenOptions(env)
  // Opened for the life of the process; a database that cannot be opened stops the start.
  const oauth = env.oauth ? (await openOAuth(env.oauth)).oauth : undefined
  log('info', `Starting HTTP transport on ${hostname}:${port}...`)
  if (oauth) log('info', `OAuth on for ${oauth.resource}; tokens kept in ${env.oauth?.kvPath}`)
  if (oauth && token && !env.allowBearerTokenWithOAuth) {
    log(
      'warn',
      'MCP_BEARER_TOKEN is refused: OAuth is on and ALLOW_BEARER_TOKEN_WITH_OAUTH is off',
    )
  }
  Deno.serve(
    { hostname, port },
    createHttpHandler(mcp, token, log, httpHandlerOptions(env, oauth)),
  )
  log('info', `HTTP server listening on ${hostname}:${port}`)
}

/** Options for {@link createHttpHandler}. */
export interface HttpHandlerOptions {
  trustedProxies?: readonly string[]
  oauth?: OAuth
  /** Accept the static token while `oauth` is set. Without it the static token is refused. */
  allowBearerTokenWithOAuth?: boolean
  /**
   * Origins a browser may call `/mcp` from. A request with any other `Origin` header gets `403`;
   * a request without one, like Claude's, is not affected.
   */
  allowedOrigins?: readonly string[]
}

/** The engine options the server runs with: the owner's time zone, when the environment names one. */
export function engineOptions(env: Pick<Env, 'timeZone'>): EngineOptions {
  return { zone: env.timeZone }
}

/** The handler options the HTTP transport runs with, taken from the environment. */
export function httpHandlerOptions(
  env: Pick<Env, 'trustedProxies' | 'allowBearerTokenWithOAuth' | 'oauth'>,
  oauth: OAuth | undefined,
): HttpHandlerOptions {
  return {
    trustedProxies: env.trustedProxies,
    oauth,
    allowBearerTokenWithOAuth: env.allowBearerTokenWithOAuth,
    // The server's own pages are the only browser origin it trusts; without PUBLIC_URL, none.
    allowedOrigins: env.oauth ? [env.oauth.publicUrl] : [],
  }
}

/** The part of `Deno.ServeHandlerInfo` the handler reads. */
interface PeerInfo {
  remoteAddr?: Deno.Addr
}

/**
 * Build the HTTP request handler. `/health` is open; `/mcp` needs the static token as
 * `Authorization: Bearer <token>`, a bare `Authorization: <token>` or `X-Api-Key: <token>`, or,
 * with `oauth`, an access token it issued. Tokens in the query string are refused: URLs end up in
 * proxy and access logs. With `oauth`, a request without a valid token gets `401` with
 * `WWW-Authenticate` pointing at the protected resource metadata, and the OAuth routes are open.
 *
 * With `oauth` the static token is refused unless `allowBearerTokenWithOAuth` is set. A refused
 * static token is checked as an OAuth token and gets the same `401` as any wrong token, so a client
 * cannot tell whether a static token is configured.
 *
 * Clients are rate limited per IP address: the peer address, or the first `X-Forwarded-For` hop
 * when the peer is one of `trustedProxies`. Each client gets `AUTH_FAILURE_LIMIT` wrong tokens a
 * minute, checked before the token comparison, `CONSENT_PAGE_LIMIT` consent pages a minute, and
 * `RATE_LIMIT` requests a minute.
 *
 * A request to `/mcp` with an `Origin` header outside `allowedOrigins` gets `403` before anything
 * else, so a web page the owner visits cannot use the server through their browser (DNS
 * rebinding, a local server). Clients that send no `Origin`, like Claude's, are not affected.
 */
export function createHttpHandler(
  mcp: McpHandler,
  token: string | undefined,
  log: Log,
  options: HttpHandlerOptions = {},
): (req: Request, info?: PeerInfo) => Promise<Response> {
  const oauth = options.oauth
  const staticTokenOn = !!token && (!oauth || options.allowBearerTokenWithOAuth === true)
  const verifier = staticTokenOn ? createTokenVerifier(token) : undefined
  const window = { windowMs: 60_000, maxBuckets: RATE_LIMIT_MAX_CLIENTS }
  const limiter = createMemoryRateLimiter({ ...window, limit: RATE_LIMIT })
  // Counts every attempt, then gives the slot back when the token was right: only failures stay.
  const authFailures = createMemoryRateLimiter({ ...window, limit: AUTH_FAILURE_LIMIT })
  const consentPages = createMemoryRateLimiter({ ...window, limit: CONSENT_PAGE_LIMIT })
  const ipOptions = { trustedProxies: options.trustedProxies ?? [] }
  const allowedOrigins = new Set(options.allowedOrigins ?? [])

  return async (req: Request, info?: PeerInfo): Promise<Response> => {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return json({ status: 'ok', version: VERSION })
    }

    const origin = req.headers.get('origin')
    if (url.pathname === MCP_PATH && origin !== null && !allowedOrigins.has(origin)) {
      log('debug', `Refused ${req.method} ${url.pathname} from a browser origin it does not allow`)
      return json({ error: 'Forbidden origin' }, 403)
    }

    const addr = info?.remoteAddr
    const peer = addr && 'hostname' in addr ? addr.hostname : undefined
    const client = clientIpBucket(clientIp(req, peer, 'x-forwarded-for', ipOptions))

    if (oauth?.handles(url.pathname)) {
      const decision = limiter.check(client)
      if (!decision.allowed) return tooManyRequests(decision.retryAfterMs)
      // Opening a consent page may fetch a client document and stores a pending consent. Wrong
      // owner passwords on its submission are capped by the library, per client and in total.
      if (url.pathname === AUTHORIZE_PATH && req.method === 'GET') {
        const page = consentPages.check(client)
        if (!page.allowed) return tooManyRequests(page.retryAfterMs)
      }
      return await oauth.fetch(req, client)
    }

    // Reserve, verify and refund with no await between them for the static token, so parallel
    // right-token requests never hold a reserved slot at the same time and cannot exhaust the
    // wrong-token budget. An OAuth token needs a store lookup, so its slot is held until then.
    const attempt = authFailures.check(client)
    if (!attempt.allowed) return tooManyRequests(attempt.retryAfterMs)
    if (!(verifier && isAuthorized(req, verifier))) {
      const refused = oauth ? await oauth.authenticate(req) : json({ error: 'Unauthorized' }, 401)
      if (refused) {
        // Never log what the client sent: a near-miss token is still a secret.
        log('debug', `Auth failed for ${req.method} ${url.pathname}`)
        return refused
      }
    }
    authFailures.refund(client, attempt.at)

    const decision = limiter.check(client)
    if (!decision.allowed) return tooManyRequests(decision.retryAfterMs)

    if (url.pathname === MCP_PATH) {
      if (req.method === 'POST') return await handleMcpPost(req, mcp)
      return json({ error: 'Method not allowed' }, 405, { 'Allow': 'POST' })
    }

    return json({ error: 'Not found' }, 404)
  }
}

function tooManyRequests(retryAfterMs: number): Response {
  const retryAfter = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
  return json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': retryAfter })
}

/** Check the `Authorization` header, then `X-Api-Key`, through the constant-time verifier. */
function isAuthorized(req: Request, verifier: ReturnType<typeof createTokenVerifier>): boolean {
  const candidates = [bearerTokenFromHeaders(req.headers), req.headers.get('X-Api-Key')]
  return candidates.some((candidate) => !!candidate && verifier.verifySync(candidate))
}

/** Header a Streamable HTTP client sends after initialization with the negotiated version. */
const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version'
/** Header that carries the session id the server assigns at initialization. */
export const SESSION_ID_HEADER = 'Mcp-Session-Id'

/**
 * Answer one Streamable HTTP POST: a JSON-RPC message or batch in, a JSON response out, or `202`
 * when it held no request. An `initialize` answer carries a new `Mcp-Session-Id`. The server keeps
 * no per-session state, so later requests are served with or without that header.
 */
async function handleMcpPost(req: Request, mcp: McpHandler): Promise<Response> {
  const version = req.headers.get(PROTOCOL_VERSION_HEADER)
  if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return json({ error: `Unsupported ${PROTOCOL_VERSION_HEADER}` }, 400)
  }
  let body: string
  try {
    body = await readBoundedText(req, { maxBytes: MAX_BODY_BYTES })
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return json({ error: 'Payload too large' }, 413)
    if (err instanceof BodyReadTimeoutError) return json({ error: 'Request timeout' }, 408)
    throw err
  }
  const response = await mcp.handleMessage(body)
  // Notifications and client responses get no answer: acknowledge them without a body.
  if (!response) return new Response(null, { status: 202 })
  const initialized = [response].flat().some(isInitializeResult)
  return json(response, 200, initialized ? { [SESSION_ID_HEADER]: uuidV7() } : {})
}

function isInitializeResult(response: JsonRpcResponse): boolean {
  const result = response.result
  return typeof result === 'object' && result !== null && 'protocolVersion' in result
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

// ── Entry ──
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err)
    Deno.exit(1)
  })
}
