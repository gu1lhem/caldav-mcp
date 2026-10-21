// ── `caldav-mcp grants` tests: the command's own answers; the full revoke is in oauth_test.ts ──

import { GRANTS_USAGE, runGrants, runGrantsCommand } from './grants.ts'
import type { GrantRecord } from '@spy4x/server/mcp-oauth'
import { assertEquals } from 'std/assert/mod.ts'

const GRANT: GrantRecord = {
  grantId: 'g1',
  clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  resource: 'https://mcp.example.com/mcp',
  scope: '',
  createdAt: Date.UTC(2026, 9, 1),
  expiresAt: Date.UTC(2026, 11, 30),
}

/** A store holding `grants`, recording every revoke it is asked for. */
function fakeStore(grants: GrantRecord[]) {
  const revoked: [string, number][] = []
  return {
    revoked,
    listGrants: () => Promise.resolve(grants),
    revokeGrant: (grantId: string, until: number) => {
      revoked.push([grantId, until])
      return Promise.resolve()
    },
  }
}

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, output: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

Deno.test('grants list prints each grant with its id, client host, start and end', async () => {
  const { out, output } = capture()
  assertEquals(await runGrants(['list'], fakeStore([GRANT]), output), 0)
  assertEquals(out, [
    'g1  claude.ai  started 2026-10-01T00:00:00.000Z  ends 2026-12-30T00:00:00.000Z',
  ])
})

Deno.test('grants list says so when there are no grants', async () => {
  const { out, output } = capture()
  assertEquals(await runGrants(['list'], fakeStore([]), output), 0)
  assertEquals(out, ['No grants.'])
})

Deno.test('grants revoke revokes the grant until it would have ended', async () => {
  const store = fakeStore([GRANT])
  const { out, output } = capture()
  assertEquals(await runGrants(['revoke', 'g1'], store, output), 0)
  assertEquals(store.revoked, [['g1', GRANT.expiresAt]])
  assertEquals(out.length, 1)
})

Deno.test('grants revoke with an unknown id revokes nothing and exits 1', async () => {
  const store = fakeStore([GRANT])
  const { err, output } = capture()
  assertEquals(await runGrants(['revoke', 'g2'], store, output), 1)
  assertEquals(store.revoked, [])
  assertEquals(err.length, 1)
})

Deno.test('a wrong grants call prints the usage and exits 2', async () => {
  for (const args of [[], ['revoke'], ['list', 'x'], ['revoke', 'g1', 'g2'], ['drop']]) {
    const store = fakeStore([GRANT])
    const { err, output } = capture()
    assertEquals(await runGrants(args, store, output), 2, args.join(' '))
    assertEquals(err, [GRANTS_USAGE])
    assertEquals(store.revoked, [])
  }
})

Deno.test('a wrong grants call prints the usage before it opens the store', async () => {
  const { err, output } = capture()
  assertEquals(await runGrantsCommand(['drop'], '/nonexistent/oauth.kv', output), 2)
  assertEquals(err, [GRANTS_USAGE])
})

Deno.test('grants on a store path that does not exist fails naming the path and creates nothing', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const path = `${dir}/oauth.kv`
    const { err, output } = capture()
    assertEquals(await runGrantsCommand(['list'], path, output), 1)
    assertEquals(err.length, 1)
    assertEquals(err[0]!.includes(`${path} (OAUTH_KV_PATH)`), true)
    assertEquals([...Deno.readDirSync(dir)], [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
