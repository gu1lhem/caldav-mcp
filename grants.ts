// ── `caldav-mcp grants`: the owner's view of who is signed in ──
// Lists the OAuth grants the owner approved and revokes one, straight from the Deno KV store, so a
// lost or leaked connector can be signed out without deleting oauth.kv. Safe while the server runs:
// Deno KV lets a second process open the same file (tested in oauth_test.ts).

import type { GrantRecord, OAuthStore } from '@spy4x/server/mcp-oauth'
import { KvOAuthStore } from '@spy4x/server/mcp-oauth/kv-store'
import { DEFAULT_OAUTH_KV_PATH } from './oauth.ts'

/** How to call the command; printed on a wrong call. */
export const GRANTS_USAGE = 'Usage: caldav-mcp grants list | caldav-mcp grants revoke <grantId>'

/** Where the command writes: `out` for results, `err` for errors and usage. */
export interface GrantsOutput {
  out(line: string): void
  err(line: string): void
}

/**
 * Run `grants list` or `grants revoke <grantId>` against `store`. `list` prints one line per grant
 * that has not ended, oldest first: its id, the client's host, when it started and when it ends.
 * `revoke` signs that one client out and keeps every other one signed in.
 *
 * @returns The process exit code: 0 on success, 1 for an unknown grant, 2 for a wrong call.
 */
export async function runGrants(
  args: readonly string[],
  store: Pick<OAuthStore, 'listGrants' | 'revokeGrant'>,
  output: GrantsOutput,
): Promise<number> {
  if (!isValidCall(args)) {
    output.err(GRANTS_USAGE)
    return 2
  }
  const [command, grantId] = args
  if (command === 'list') {
    const grants = await store.listGrants()
    if (grants.length === 0) output.out('No grants.')
    for (const grant of grants) output.out(describe(grant))
    return 0
  }
  const grant = (await store.listGrants()).find((g) => g.grantId === grantId)
  if (!grant) {
    output.err(`No grant ${grantId}. Run "caldav-mcp grants list" to see the current ones.`)
    return 1
  }
  await store.revokeGrant(grant.grantId, grant.expiresAt)
  output.out(`Revoked ${describe(grant)}`)
  return 0
}

/** `list` alone, or `revoke` and one non-empty grant id. */
function isValidCall(args: readonly string[]): boolean {
  if (args.length === 1) return args[0] === 'list'
  return args.length === 2 && args[0] === 'revoke' && !!args[1]
}

/**
 * Open the OAuth store at `OAUTH_KV_PATH` (default {@link DEFAULT_OAUTH_KV_PATH}), run
 * {@link runGrants} on it and close it. Needs `--unstable-kv`.
 */
export async function runGrantsCommand(
  args: readonly string[],
  kvPath: string = Deno.env.get('OAUTH_KV_PATH')?.trim() || DEFAULT_OAUTH_KV_PATH,
  output: GrantsOutput = { out: console.log, err: console.error },
): Promise<number> {
  if (!isValidCall(args)) {
    output.err(GRANTS_USAGE)
    return 2
  }
  let kv: Deno.Kv
  try {
    // Deno KV creates a missing file; refuse instead, so a wrong path is not mistaken for no
    // grants.
    await Deno.stat(kvPath)
    kv = await Deno.openKv(kvPath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    output.err(`Cannot open the OAuth store at ${kvPath} (OAUTH_KV_PATH): ${reason}`)
    return 1
  }
  try {
    return await runGrants(args, new KvOAuthStore(kv), output)
  } finally {
    kv.close()
  }
}

function describe(grant: GrantRecord): string {
  const started = new Date(grant.createdAt).toISOString()
  const ends = new Date(grant.expiresAt).toISOString()
  return `${grant.grantId}  ${hostOf(grant.clientId)}  started ${started}  ends ${ends}`
}

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host
  } catch {
    return clientId
  }
}
