// ── Environment config tests ──

import { loadEnv } from './env.ts'
import { createEnvReader } from '@spy4x/server/config/env'
import { assertEquals, assertThrows } from 'std/assert/mod.ts'

/** Run `fn` with the given env vars set (undefined = unset), restoring the old values after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]))
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) Deno.env.delete(k)
      else Deno.env.set(k, val)
    }
  }
  apply(vars)
  try {
    fn()
  } finally {
    apply(saved)
  }
}

const BASE = {
  CALDAV_URL: 'https://cal.example.com/',
  CALDAV_SERVER_URL: undefined,
  CALDAV_USERNAME: 'user',
  CALDAV_PASSWORD: 'pass',
}

Deno.test('the HTTP host defaults to loopback', () => {
  withEnv({ ...BASE, HOST: undefined }, () => {
    assertEquals(loadEnv().host, '127.0.0.1')
  })
})

Deno.test('HOST overrides the HTTP host', () => {
  withEnv({ ...BASE, HOST: '0.0.0.0' }, () => {
    assertEquals(loadEnv().host, '0.0.0.0')
  })
})

Deno.test('an empty MCP_BEARER_TOKEN counts as unset', () => {
  withEnv({ ...BASE, MCP_BEARER_TOKEN: '' }, () => {
    assertEquals(loadEnv().mcpBearerToken, undefined)
  })
})

/** `loadEnv` over a fixed record on top of the required CalDAV settings. */
function load(vars: Record<string, string | undefined>) {
  return loadEnv(createEnvReader({ ...BASE, ...vars }))
}

Deno.test('PORT must be a whole number from 1 to 65535', () => {
  assertEquals(load({ PORT: '8080' }).port, 8080)
  assertEquals(load({}).port, 3000)
  for (const bad of ['abc', '3000abc', '0', '65536', '-1', '1e3']) {
    assertThrows(() => load({ PORT: bad }), Error, 'PORT')
  }
})

Deno.test('LOG_LEVEL must be a known level', () => {
  assertEquals(load({}).logLevel, 'info')
  assertEquals(load({ LOG_LEVEL: 'debug' }).logLevel, 'debug')
  assertThrows(() => load({ LOG_LEVEL: 'verbose' }), Error, 'LOG_LEVEL')
})

Deno.test('TRUSTED_PROXIES is a comma-separated CIDR list, empty by default', () => {
  assertEquals(load({}).trustedProxies, [])
  assertEquals(load({ TRUSTED_PROXIES: '172.16.0.0/12, 10.0.0.1/32,' }).trustedProxies, [
    '172.16.0.0/12',
    '10.0.0.1/32',
  ])
  assertThrows(() => load({ TRUSTED_PROXIES: 'true' }), Error, 'TRUSTED_PROXIES')
  assertThrows(() => load({ TRUSTED_PROXIES: '10.0.0.0/33' }), Error, 'TRUSTED_PROXIES')
})

Deno.test('a missing CalDAV password stops startup', () => {
  assertThrows(() => load({ CALDAV_PASSWORD: undefined }), Error, 'CALDAV_PASSWORD')
})

const OAUTH = {
  PUBLIC_URL: 'https://mcp.example.com',
  OWNER_PASSWORD_HASH: `pbkdf2-sha256$600000$${'0'.repeat(32)}$${'0'.repeat(64)}`,
  AUTH_PEPPER: 'p'.repeat(32),
}

Deno.test('OAuth is off when none of its env vars is set', () => {
  assertEquals(load({}).oauth, undefined)
})

Deno.test('OAuth is on when all three of its env vars are set', () => {
  assertEquals(load({ ...OAUTH, PUBLIC_URL: 'https://mcp.example.com/' }).oauth, {
    publicUrl: 'https://mcp.example.com',
    ownerPasswordHash: OAUTH.OWNER_PASSWORD_HASH,
    authPepper: OAUTH.AUTH_PEPPER,
    kvPath: '/data/oauth.kv',
  })
})

Deno.test('ALLOW_BEARER_TOKEN_WITH_OAUTH is off unless set to true', () => {
  assertEquals(load({}).allowBearerTokenWithOAuth, false)
  assertEquals(load({ ALLOW_BEARER_TOKEN_WITH_OAUTH: '' }).allowBearerTokenWithOAuth, false)
  assertEquals(load({ ALLOW_BEARER_TOKEN_WITH_OAUTH: 'false' }).allowBearerTokenWithOAuth, false)
  assertEquals(load({ ALLOW_BEARER_TOKEN_WITH_OAUTH: 'true' }).allowBearerTokenWithOAuth, true)
})

Deno.test('ALLOW_BEARER_TOKEN_WITH_OAUTH other than true or false stops startup', () => {
  for (const value of ['yes', '1', 'TRUE']) {
    assertThrows(
      () => load({ ALLOW_BEARER_TOKEN_WITH_OAUTH: value }),
      Error,
      'ALLOW_BEARER_TOKEN_WITH_OAUTH must be true or false',
    )
  }
})

Deno.test('CALDAV_MCP_TOOLS defaults to all and accepts each mode', () => {
  assertEquals(load({}).tools, 'all')
  assertEquals(load({ CALDAV_MCP_TOOLS: '' }).tools, 'all')
  for (const mode of ['all', 'no-delete', 'read-only']) {
    assertEquals(load({ CALDAV_MCP_TOOLS: mode }).tools, mode)
  }
})

Deno.test('an unknown CALDAV_MCP_TOOLS stops startup', () => {
  for (const value of ['read', 'NO-DELETE', 'none', 'true']) {
    assertThrows(
      () => load({ CALDAV_MCP_TOOLS: value }),
      Error,
      'CALDAV_MCP_TOOLS must be one of: all, no-delete, read-only',
    )
  }
})

Deno.test('OAUTH_KV_PATH moves the OAuth store', () => {
  assertEquals(load({ ...OAUTH, OAUTH_KV_PATH: '/srv/oauth.kv' }).oauth?.kvPath, '/srv/oauth.kv')
})

Deno.test('a half-configured OAuth stops startup, naming each missing variable', () => {
  for (const name of Object.keys(OAUTH)) {
    const error = assertThrows(() => load({ ...OAUTH, [name]: undefined }), Error)
    assertEquals(error.message.endsWith(`missing: ${name}`), true, error.message)
  }
  assertThrows(
    () => load({ AUTH_PEPPER: OAUTH.AUTH_PEPPER }),
    Error,
    'PUBLIC_URL, OWNER_PASSWORD_HASH',
  )
})

Deno.test('CALDAV_MCP_TIME_ZONE is unset by default and accepts an IANA zone', () => {
  assertEquals(load({}).timeZone, undefined)
  assertEquals(load({ CALDAV_MCP_TIME_ZONE: '' }).timeZone, undefined)
  assertEquals(load({ CALDAV_MCP_TIME_ZONE: 'Asia/Bangkok' }).timeZone, 'Asia/Bangkok')
})

Deno.test('an unknown CALDAV_MCP_TIME_ZONE stops startup', () => {
  for (const value of ['Mars/Olympus', 'bangkok time']) {
    assertThrows(
      () => load({ CALDAV_MCP_TIME_ZONE: value }),
      Error,
      'CALDAV_MCP_TIME_ZONE must be an IANA time zone name',
    )
  }
})

Deno.test('PUBLIC_URL must be a bare https origin', () => {
  const bad = [
    'mcp.example.com',
    'http://mcp.example.com',
    'https://mcp.example.com/mcp',
    'https://mcp.example.com?x=1',
    'https://user@mcp.example.com',
  ]
  for (const url of bad) {
    assertThrows(() => load({ ...OAUTH, PUBLIC_URL: url }), Error, 'PUBLIC_URL')
  }
  assertEquals(
    load({ ...OAUTH, PUBLIC_URL: 'http://localhost:3000' }).oauth?.publicUrl,
    'http://localhost:3000',
  )
})

Deno.test('OWNER_PASSWORD_HASH must be a pbkdf2-sha256 hash, not a plain password', () => {
  for (const hash of ['hunter2', OAUTH.OWNER_PASSWORD_HASH.slice(0, -1)]) {
    assertThrows(() => load({ ...OAUTH, OWNER_PASSWORD_HASH: hash }), Error, 'OWNER_PASSWORD_HASH')
  }
})

Deno.test('AUTH_PEPPER must be at least 32 characters', () => {
  assertThrows(() => load({ ...OAUTH, AUTH_PEPPER: 'p'.repeat(31) }), Error, 'AUTH_PEPPER')
})
