// ── HTTP transport tests ──

import {
  AUTH_FAILURE_LIMIT,
  createHttpHandler,
  createLogger,
  engineOptions,
  httpHandlerOptions,
  httpListenOptions,
  MAX_BODY_BYTES,
  SESSION_ID_HEADER,
  VERSION,
} from './main.ts'
import { McpHandler } from './mcp.ts'
import { loadEnv } from './env.ts'
import { QueryEngine } from './caldav/query.ts'
import { registerAllTools } from './tools/index.ts'
import { createFakeCalDav, HOME, ORIGIN, PASSWORD, USER } from './caldav/testing/fake_caldav.ts'
import { createCalDavClient } from '@spy4x/caldav'
import { createEnvReader } from '@spy4x/server/config/env'
import { assertEquals, assertMatch, assertNotEquals, assertThrows } from 'std/assert/mod.ts'
import { UUID_V7_PATTERN } from '@spy4x/platform/universal/uuid'

const TOKEN = 'test-token-123'

function setup(options: { trustedProxies?: string[]; allowedOrigins?: string[] } = {}) {
  const logs: string[] = []
  const handler = createHttpHandler(
    new McpHandler({ name: 'test', version: '0.0.0' }),
    TOKEN,
    (level, msg) => logs.push(`${level} ${msg}`),
    options,
  )
  return { handler, logs }
}

function post(body: unknown, headers: Record<string, string>, path = '/mcp'): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const PING = { jsonrpc: '2.0', id: 1, method: 'ping' }

Deno.test('HTTP mode refuses to start without MCP_BEARER_TOKEN', () => {
  assertThrows(
    () => httpListenOptions({ host: '127.0.0.1', port: 3000 }),
    Error,
    'MCP_BEARER_TOKEN',
  )
})

Deno.test('HTTP mode starts with OAuth alone, without MCP_BEARER_TOKEN', () => {
  const oauth = {
    publicUrl: 'https://mcp.example.com',
    ownerPasswordHash: 'h',
    authPepper: 'p',
    kvPath: '/data/oauth.kv',
  }
  assertEquals(httpListenOptions({ host: '127.0.0.1', port: 3000, oauth }), {
    hostname: '127.0.0.1',
    port: 3000,
    token: undefined,
  })
})

Deno.test('the HTTP transport passes ALLOW_BEARER_TOKEN_WITH_OAUTH to the handler, refusing when unset', () => {
  const allowed = (value: string | undefined) => {
    const env = loadEnv(createEnvReader({
      CALDAV_URL: 'https://cal.example.com',
      CALDAV_USERNAME: 'user',
      CALDAV_PASSWORD: 'pass',
      ALLOW_BEARER_TOKEN_WITH_OAUTH: value,
    }))
    return httpHandlerOptions(env, undefined).allowBearerTokenWithOAuth
  }
  assertEquals(allowed(undefined), false)
  assertEquals(allowed('false'), false)
  assertEquals(allowed('true'), true)
})

Deno.test('the HTTP transport allows browser calls only from PUBLIC_URL, and none without it', () => {
  const origins = (vars: Record<string, string>) => {
    const env = loadEnv(createEnvReader({
      CALDAV_URL: 'https://cal.example.com',
      CALDAV_USERNAME: 'user',
      CALDAV_PASSWORD: 'pass',
      ...vars,
    }))
    return httpHandlerOptions(env, undefined).allowedOrigins
  }
  assertEquals(origins({}), [])
  assertEquals(
    origins({
      PUBLIC_URL: 'https://mcp.example.com/',
      OWNER_PASSWORD_HASH: `pbkdf2-sha256$600000$${'0'.repeat(32)}$${'0'.repeat(64)}`,
      AUTH_PEPPER: 'p'.repeat(32),
    }),
    ['https://mcp.example.com'],
  )
})

Deno.test('a browser request to /mcp from an origin it does not allow gets 403, even with the right token', async () => {
  const { handler } = setup({ allowedOrigins: ['https://mcp.example.com'] })
  for (const origin of ['https://evil.example', 'null', 'https://mcp.example.com.evil.example']) {
    const res = await handler(post(PING, { 'Authorization': `Bearer ${TOKEN}`, 'Origin': origin }))
    assertEquals(res.status, 403, origin)
    await res.body?.cancel()
  }
})

Deno.test('a request to /mcp without an Origin header, or from an allowed one, is served', async () => {
  const { handler } = setup({ allowedOrigins: ['https://mcp.example.com'] })
  const variants: Record<string, string>[] = [{}, { 'Origin': 'https://mcp.example.com' }]
  for (const extra of variants) {
    const res = await handler(post(PING, { 'Authorization': `Bearer ${TOKEN}`, ...extra }))
    assertEquals(res.status, 200, JSON.stringify(extra))
    await res.body?.cancel()
  }
})

Deno.test('HTTP mode listens on the configured host and port', () => {
  assertEquals(httpListenOptions({ host: '127.0.0.1', port: 3001, mcpBearerToken: TOKEN }), {
    hostname: '127.0.0.1',
    port: 3001,
    token: TOKEN,
  })
})

Deno.test('a token in the api_key query parameter is refused', async () => {
  const { handler } = setup()
  const res = await handler(post(PING, {}, `/mcp?api_key=${TOKEN}`))
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test('a failed login never logs the token the client sent', async () => {
  const { handler, logs } = setup()
  const sent = 'near-miss-secret'
  const res = await handler(
    post(PING, { 'Authorization': `Bearer ${sent}`, 'X-Api-Key': sent }, `/mcp?api_key=${sent}`),
  )
  await res.body?.cancel()
  assertEquals(res.status, 401)
  assertEquals(logs.length > 0, true)
  assertEquals(logs.some((line) => line.includes(sent)), false)
})

// OAuth off: the static token is the only way in and needs no ALLOW_BEARER_TOKEN_WITH_OAUTH.
Deno.test('without OAuth the token is accepted as a Bearer header, a bare Authorization header or an X-Api-Key header', async () => {
  const { handler } = setup()
  const variants: Record<string, string>[] = [
    { 'Authorization': `Bearer ${TOKEN}` },
    { 'Authorization': TOKEN },
    { 'X-Api-Key': TOKEN },
  ]
  for (const headers of variants) {
    const res = await handler(post(PING, headers))
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { jsonrpc: '2.0', id: 1, result: {} })
  }
})

Deno.test('a posted notification gets 202 with no body', async () => {
  const { handler } = setup()
  const res = await handler(
    post({ jsonrpc: '2.0', method: 'notifications/initialized' }, {
      'Authorization': `Bearer ${TOKEN}`,
    }),
  )
  assertEquals(res.status, 202)
  assertEquals(await res.text(), '')
})

Deno.test('GET /mcp is not offered', async () => {
  const { handler } = setup()
  const res = await handler(
    new Request('http://localhost/mcp', { headers: { 'Authorization': `Bearer ${TOKEN}` } }),
  )
  await res.body?.cancel()
  assertEquals(res.status, 405)
})

const AUTH = { 'Authorization': `Bearer ${TOKEN}` }

function peer(hostname: string) {
  return { remoteAddr: { transport: 'tcp' as const, hostname, port: 40000 } }
}

/** Send `count` authorized pings and return the last status. */
async function burst(
  handler: ReturnType<typeof setup>['handler'],
  count: number,
  headers: () => Record<string, string>,
  from = peer('192.0.2.1'),
): Promise<Response> {
  let res: Response | undefined
  for (let i = 0; i < count; i++) {
    await res?.body?.cancel()
    res = await handler(post(PING, { ...AUTH, ...headers() }), from)
  }
  return res!
}

Deno.test('the 101st request in a minute from one client gets 429 with Retry-After', async () => {
  const { handler } = setup()
  const last = await burst(handler, 100, () => ({}))
  assertEquals(last.status, 200)
  await last.body?.cancel()
  const over = await handler(post(PING, AUTH), peer('192.0.2.1'))
  await over.body?.cancel()
  assertEquals(over.status, 429)
  assertEquals(Number(over.headers.get('Retry-After')) > 0, true)
  const other = await handler(post(PING, AUTH), peer('192.0.2.2'))
  await other.body?.cancel()
  assertEquals(other.status, 200)
})

Deno.test('a forged X-Forwarded-For does not escape the limit from a peer that is not a trusted proxy', async () => {
  for (const trustedProxies of [[], ['10.0.0.0/8']]) {
    const { handler } = setup({ trustedProxies })
    let n = 0
    const res = await burst(handler, 101, () => ({ 'X-Forwarded-For': `198.51.100.${n++ % 250}` }))
    await res.body?.cancel()
    assertEquals(res.status, 429)
  }
})

Deno.test('behind a trusted proxy each X-Forwarded-For client gets its own budget', async () => {
  const { handler } = setup({ trustedProxies: ['10.0.0.0/8'] })
  const proxy = peer('10.0.0.1')
  const first = await burst(handler, 101, () => ({ 'X-Forwarded-For': '198.51.100.1' }), proxy)
  await first.body?.cancel()
  assertEquals(first.status, 429)
  const second = await handler(post(PING, { ...AUTH, 'X-Forwarded-For': '198.51.100.2' }), proxy)
  await second.body?.cancel()
  assertEquals(second.status, 200)
})

Deno.test('a POST /mcp body over the size cap gets 413', async () => {
  const { handler } = setup()
  const res = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: AUTH,
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    }),
  )
  await res.body?.cancel()
  assertEquals(res.status, 413)
})

Deno.test('log lines never contain the bearer token or the CalDAV password', () => {
  const lines: string[] = []
  const log = createLogger(
    { logLevel: 'debug', mcpBearerToken: TOKEN, caldavPassword: 'caldav-secret' },
    (line) => lines.push(line),
  )
  log('error', `request failed: Authorization: Bearer ${TOKEN}, password caldav-secret`)
  assertEquals(lines.length, 1)
  assertEquals(lines[0]!.includes(TOKEN), false)
  assertEquals(lines[0]!.includes('caldav-secret'), false)
  assertEquals(lines[0]!.startsWith('[ERROR] request failed'), true)
})

Deno.test('log lines never contain the owner password hash or the pepper', () => {
  const lines: string[] = []
  const oauth = {
    publicUrl: 'https://mcp.example.com',
    ownerPasswordHash: 'hash-secret-value',
    authPepper: 'pepper-secret-value',
    kvPath: '/data/oauth.kv',
  }
  const log = createLogger(
    { logLevel: 'debug', caldavPassword: 'caldav-secret', oauth },
    (line) => lines.push(line),
  )
  log('error', 'config dump: hash-secret-value pepper-secret-value')
  assertEquals(lines.length, 1)
  assertEquals(lines[0]!.includes('hash-secret-value'), false)
  assertEquals(lines[0]!.includes('pepper-secret-value'), false)
})

Deno.test('log lines below LOG_LEVEL are dropped', () => {
  const lines: string[] = []
  const log = createLogger({ logLevel: 'warn', caldavPassword: 'p' }, (line) => lines.push(line))
  log('info', 'quiet')
  log('warn', 'loud')
  assertEquals(lines, ['[WARN] loud'])
})

/** Send `count` requests with a wrong token from one address and return the last response. */
async function wrongTokens(
  handler: ReturnType<typeof setup>['handler'],
  count: number,
): Promise<Response> {
  let res: Response | undefined
  for (let i = 0; i < count; i++) {
    await res?.body?.cancel()
    res = await handler(post(PING, { 'Authorization': 'Bearer wrong' }), peer('192.0.2.9'))
  }
  return res!
}

Deno.test('the 11th wrong token in a minute from one address gets 429 before the token is compared', async () => {
  const { handler } = setup()
  const last = await wrongTokens(handler, AUTH_FAILURE_LIMIT)
  await last.body?.cancel()
  assertEquals(last.status, 401)
  const over = await wrongTokens(handler, 1)
  await over.body?.cancel()
  assertEquals(over.status, 429)
  assertEquals(Number(over.headers.get('Retry-After')) > 0, true)
  const right = await handler(post(PING, AUTH), peer('192.0.2.9'))
  await right.body?.cancel()
  assertEquals(right.status, 429)
})

Deno.test('right tokens do not count toward the wrong-token limit', async () => {
  const { handler } = setup()
  const ok = await burst(handler, AUTH_FAILURE_LIMIT * 2, () => ({}), peer('192.0.2.9'))
  await ok.body?.cancel()
  assertEquals(ok.status, 200)
  const wrong = await wrongTokens(handler, 1)
  await wrong.body?.cancel()
  assertEquals(wrong.status, 401)
})

Deno.test('40 parallel requests with the right token from one address get no 429', async () => {
  const { handler } = setup()
  const responses = await Promise.all(
    Array.from({ length: 40 }, () => handler(post(PING, AUTH), peer('192.0.2.9'))),
  )
  const statuses = await Promise.all(responses.map(async (res) => {
    await res.body?.cancel()
    return res.status
  }))
  assertEquals(statuses.filter((status) => status === 429).length, 0)
})

Deno.test('VERSION matches the version in deno.jsonc', async () => {
  const config = await Deno.readTextFile(new URL('./deno.jsonc', import.meta.url))
  const match = config.match(/^\s*"version":\s*"([^"]+)"/m)
  assertEquals(VERSION, match?.[1])
})

// ── Streamable HTTP ──

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
}

Deno.test('an initialize answer carries a new UUID version 7 as Mcp-Session-Id, other answers carry none', async () => {
  const { handler } = setup()
  const first = await handler(post(INITIALIZE, AUTH))
  const second = await handler(post(INITIALIZE, AUTH))
  const ping = await handler(post(PING, AUTH))
  await Promise.all([first, second, ping].map((res) => res.body?.cancel()))
  const id = first.headers.get(SESSION_ID_HEADER)
  assertMatch(id ?? '', UUID_V7_PATTERN)
  assertNotEquals(second.headers.get(SESSION_ID_HEADER), id)
  assertEquals(ping.headers.get(SESSION_ID_HEADER), null)
})

Deno.test('a request with the session id the server issued is served', async () => {
  const { handler } = setup()
  const init = await handler(post(INITIALIZE, AUTH))
  await init.body?.cancel()
  const session = init.headers.get(SESSION_ID_HEADER)!
  const res = await handler(post(PING, { ...AUTH, [SESSION_ID_HEADER]: session }))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { jsonrpc: '2.0', id: 1, result: {} })
})

Deno.test('a posted batch gets a JSON array of the answers to its requests', async () => {
  const { handler } = setup()
  const res = await handler(
    post([PING, { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...PING, id: 2 }], AUTH),
  )
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Content-Type'), 'application/json')
  assertEquals(await res.json(), [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, result: {} },
  ])
})

Deno.test('a posted batch of notifications only gets 202 with no body', async () => {
  const { handler } = setup()
  const note = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const res = await handler(post([note, note], AUTH))
  assertEquals(res.status, 202)
  assertEquals(await res.text(), '')
})

Deno.test('an unsupported MCP-Protocol-Version header gets 400', async () => {
  const { handler } = setup()
  const bad = await handler(post(PING, { ...AUTH, 'MCP-Protocol-Version': '1999-01-01' }))
  await bad.body?.cancel()
  assertEquals(bad.status, 400)
  const good = await handler(post(PING, { ...AUTH, 'MCP-Protocol-Version': '2025-06-18' }))
  await good.body?.cancel()
  assertEquals(good.status, 200)
})

const task = (uid: string, due: string) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VTODO',
    'DTSTAMP:20261001T080000Z',
    `UID:${uid}`,
    `SUMMARY:${uid}`,
    `DUE${due}`,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n'

/**
 * Calls `query_todos` on a server built the way `main` builds it from `CALDAV_MCP_TIME_ZONE`, with
 * the process running in `hostZone`. Returns the overdue count and the summaries listed.
 */
async function queryTodosUnder(
  hostZone: string,
  ownerZone: string,
  now: string,
  dues: Record<string, string>,
  args: Record<string, unknown>,
): Promise<{ overdue: unknown; listed: string[] }> {
  const before = Deno.env.get('TZ')
  Deno.env.set('TZ', hostZone)
  try {
    // Guards the test itself: if the runtime ignored TZ, both host zones would be the same one.
    assertEquals(Intl.DateTimeFormat().resolvedOptions().timeZone, hostZone)
    const tasks = `${HOME}tasks/`
    const fake = createFakeCalDav(
      { [tasks]: { displayName: 'Inbox', components: ['VTODO'] } },
      Object.fromEntries(
        Object.entries(dues).map((
          [uid, due],
        ) => [`${tasks}${uid}.ics`, { etag: `"${uid}"`, data: task(uid, due) }]),
      ),
    )
    const client = createCalDavClient({
      serverUrl: `${ORIGIN}/dav/`,
      auth: { username: USER, password: PASSWORD },
      fetch: (input, init) => fake.fetch(input, init),
    })
    const env = loadEnv(createEnvReader({
      CALDAV_URL: 'https://cal.example.com',
      CALDAV_USERNAME: 'user',
      CALDAV_PASSWORD: 'pass',
      CALDAV_MCP_TIME_ZONE: ownerZone,
    }))
    const engine = new QueryEngine(client, { ...engineOptions(env), now: () => new Date(now) })
    const mcp = new McpHandler({ name: 'test', version: '0.0.0' })
    registerAllTools(mcp, engine, 'all')
    const response = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_todos', arguments: args },
    })
    const result = response!.result as { content: { text: string }[] }
    const body = JSON.parse(result.content[0]!.text) as {
      overdue: unknown
      todos: { summary: string }[]
    }
    return { overdue: body.overdue, listed: body.todos.map((todo) => todo.summary).sort() }
  } finally {
    if (before === undefined) Deno.env.delete('TZ')
    else Deno.env.set('TZ', before)
  }
}

const HOST_ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']

// 10:00 UTC is 17:00 in Bangkok: the floating noon has passed there, the floating 20:00 has not.
const TIMED = {
  noon: ':20261011T120000',
  evening: ':20261011T200000',
  fixed: ':20261011T120000Z',
}

Deno.test('with CALDAV_MCP_TIME_ZONE set, overdue counts floating due times in that zone under any host zone', async () => {
  for (const host of HOST_ZONES) {
    const result = await queryTodosUnder(host, 'Asia/Bangkok', '2026-10-11T10:00:00Z', TIMED, {})
    assertEquals(result.overdue, 1, `host zone ${host}`)
  }
})

Deno.test('with CALDAV_MCP_TIME_ZONE set, a UTC dueBefore picks the same floating tasks under any host zone', async () => {
  for (const host of HOST_ZONES) {
    const result = await queryTodosUnder(host, 'Asia/Bangkok', '2026-10-11T10:00:00Z', TIMED, {
      dueBefore: '2026-10-11T09:00:00Z',
    })
    assertEquals(result.listed, ['noon'], `host zone ${host}`)
  }
})

Deno.test('with CALDAV_MCP_TIME_ZONE set, a floating dueBefore is read in that zone under any host zone', async () => {
  for (const host of HOST_ZONES) {
    // 18:00 in Bangkok is 11:00 UTC: before the task fixed at 12:00 UTC.
    const result = await queryTodosUnder(host, 'Asia/Bangkok', '2026-10-11T10:00:00Z', TIMED, {
      dueBefore: '2026-10-11T18:00:00',
    })
    assertEquals(result.listed, ['noon'], `host zone ${host}`)
  }
})

Deno.test('with CALDAV_MCP_TIME_ZONE set, a whole-day task is overdue once its day ends in that zone under any host zone', async () => {
  // 18:00 UTC on the 11th is 01:00 on the 12th in Bangkok, and still the 11th in UTC.
  for (const host of HOST_ZONES) {
    const result = await queryTodosUnder(
      host,
      'Asia/Bangkok',
      '2026-10-11T18:00:00Z',
      { allDay: ';VALUE=DATE:20261011' },
      {},
    )
    assertEquals(result.overdue, 1, `host zone ${host}`)
  }
})
