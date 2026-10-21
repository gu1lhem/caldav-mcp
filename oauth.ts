// ── OAuth for remote connectors (claude.ai, the Claude apps, Claude Code) ──
// The authorization server, its Deno KV store and the resource-server guard come from
// @spy4x/server/mcp-oauth; this module wires them to one owner password and to plain
// `Request`/`Response` handlers.

import { Hono } from 'hono'
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  createAuthorizationServer,
  createClientMetadataFetcher,
  createResourceServer,
  type OAuthStore,
  TOKEN_PATH,
} from '@spy4x/server/mcp-oauth'
import { KvOAuthStore } from '@spy4x/server/mcp-oauth/kv-store'
import { createPasswordHasher } from '@spy4x/server/sign-in'
import type { Fetcher } from '@spy4x/net/safe-fetch'
import type { DnsResolver } from '@spy4x/net/url-policy'

/** The path the MCP endpoint is served at; the OAuth resource is `PUBLIC_URL` plus this path. */
export const MCP_PATH = '/mcp'

/** Where the OAuth store lives when `OAUTH_KV_PATH` is unset: a file on the `/data` volume. */
export const DEFAULT_OAUTH_KV_PATH = '/data/oauth.kv'

export interface OAuthConfig {
  /** The server's public origin, such as `https://caldav-mcp.example.com`. Also the issuer. */
  publicUrl: string
  /** `pbkdf2-sha256$…` hash of the owner's password, made under `authPepper`. */
  ownerPasswordHash: string
  /** The hasher's pepper: at least 32 characters. */
  authPepper: string
  /** The Deno KV file that keeps grants and tokens across restarts. */
  kvPath: string
}

/**
 * Hosts a `client_id` may live on. Claude's documents are on claude.ai
 * (`/oauth/mcp-oauth-client-metadata` for the apps, `/oauth/claude-code-client-metadata` for
 * Claude Code). Any other host is refused before anything is fetched, so a stranger cannot make
 * the server send requests to a URL of their choice.
 */
export const TRUSTED_CLIENT_HOSTS: readonly string[] = ['claude.ai']

/** Seams for tests. Production passes none. */
export interface OAuthOptions {
  /** Network seam for fetching client metadata documents. Defaults to the platform `fetch`. */
  fetcher?: Fetcher
  /** DNS seam for the same fetch. Defaults to the system resolver. */
  resolver?: DnsResolver
}

export interface OAuth {
  /** The resource clients must name: `publicUrl` plus {@link MCP_PATH}. */
  resource: string
  /** True for a path this module serves: the two metadata documents, `/authorize`, `/token`. */
  handles(pathname: string): boolean
  /**
   * Serve a request for a path {@link OAuth.handles}. `clientAddress` is the client's address as
   * the rate limiter sees it; wrong owner passwords are counted per address.
   */
  fetch(req: Request, clientAddress?: string): Promise<Response>
  /**
   * Check the access token of an MCP request. `undefined` means it is valid for this server;
   * otherwise the `401` response to send, with `WWW-Authenticate` pointing at the metadata.
   */
  authenticate(req: Request): Promise<Response | undefined>
}

/** The OAuth server for one owner, and the way to close the database its tokens live in. */
export interface OpenedOAuth {
  oauth: OAuth
  close(): void
}

/**
 * Open the Deno KV database at `config.kvPath` as the token store, so a restart keeps connectors
 * signed in, and build the OAuth server on it. Needs `--unstable-kv`. Deno KV creates the file but
 * not its directory.
 *
 * @throws {Error} Naming the path when the database cannot be opened, so the server never starts
 * with OAuth on and nowhere to keep its tokens.
 * @throws {TypeError} When the URL, the pepper or anything the library checks is invalid.
 */
export async function openOAuth(
  config: OAuthConfig,
  options: OAuthOptions = {},
): Promise<OpenedOAuth> {
  let kv: Deno.Kv
  try {
    kv = await Deno.openKv(config.kvPath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot open the OAuth store at ${config.kvPath} (OAUTH_KV_PATH): ${reason}`)
  }
  try {
    return { oauth: createOAuth(config, new KvOAuthStore(kv), options), close: () => kv.close() }
  } catch (err) {
    kv.close()
    throw err
  }
}

/** What {@link OAuth.fetch} hands the Hono app as `c.env`. */
interface RequestBindings {
  clientAddress?: string
}

/**
 * Build the authorization server and the resource-server guard for one owner.
 *
 * The owner proves who they are with a password on the consent page (the library's
 * `ownerPassword`), since this server has no forward-auth in front of it. Approving needs the
 * password; denying does not. After 10 wrong passwords in 15 minutes from one client address the
 * library refuses approvals from that address with `429` until the window ends; after 100 in 24
 * hours from all addresses together it refuses every approval. The counts live in the store, so a
 * restart keeps them. Each grant ends 90 days after the owner approved it, however often its
 * client refreshes.
 *
 * @throws {TypeError} When the URL, the pepper or anything the library checks is invalid.
 */
function createOAuth(config: OAuthConfig, store: OAuthStore, options: OAuthOptions): OAuth {
  const hasher = createPasswordHasher({ pepper: config.authPepper })
  const issuer = config.publicUrl
  const resource = issuer + MCP_PATH

  const authorization = createAuthorizationServer({
    issuer,
    resources: [resource],
    store,
    clients: createClientMetadataFetcher({
      trustedHosts: TRUSTED_CLIENT_HOSTS,
      fetcher: options.fetcher,
      resolver: options.resolver,
    }),
    ownerPassword: {
      hash: config.ownerPasswordHash,
      hasher,
      // The address `fetch` was given: the one the HTTP handler rate limits by.
      clientAddress: (c) => (c.env as RequestBindings | undefined)?.clientAddress,
    },
  })
  const resourceServer = createResourceServer({
    resource,
    issuer,
    verifier: authorization.verifier,
  })

  const app = new Hono()
  app.get(resourceServer.metadataPath, resourceServer.metadataHandler)
  app.route('/', authorization.app)

  // The guard is Hono middleware; a request it lets through reaches this marker route.
  const guard = new Hono()
  guard.use('*', resourceServer.guard)
  guard.all('*', (c) => c.body(null, 204))

  const paths = new Set([
    AUTHORIZATION_SERVER_METADATA_PATH,
    resourceServer.metadataPath,
    AUTHORIZE_PATH,
    TOKEN_PATH,
  ])

  return {
    resource: resourceServer.resource,
    handles: (pathname) => paths.has(pathname),
    fetch: async (req, clientAddress) => {
      const bindings: RequestBindings = { clientAddress }
      return await app.fetch(req, bindings)
    },
    async authenticate(req) {
      const res = await guard.fetch(req)
      return res.status === 204 ? undefined : res
    },
  }
}
