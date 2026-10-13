# Configuration

All settings are environment variables, read once at startup.

| Env Var | Default | Description |
|---------|---------|-------------|
| `CALDAV_URL` | — | CalDAV server URL (or `CALDAV_SERVER_URL`) |
| `CALDAV_USERNAME` | — | CalDAV auth username |
| `CALDAV_PASSWORD` | — | CalDAV auth password |
| `HOST` | `127.0.0.1` | Interface the HTTP mode binds to. Set `0.0.0.0` inside a container |
| `PORT` | `3000` | HTTP port (for `--http` mode) |
| `MCP_BEARER_TOKEN` | — | Static token for HTTP mode. Without it or OAuth `--http` refuses to start. Setting it also turns HTTP mode on. Refused while OAuth is on, unless the next variable allows it |
| `ALLOW_BEARER_TOKEN_WITH_OAUTH` | `false` | `true` accepts `MCP_BEARER_TOKEN` next to OAuth. No effect without OAuth. Any value other than `true` or `false` stops startup |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `CALDAV_MCP_TOOLS` | `all` | Which tools the server offers. `all`: every tool. `no-delete`: leaves out `delete_calendar`, `delete_event` and `delete_todo`. `read-only`: offers only `list_calendars`, `query_events`, `get_event`, `query_todos` and `get_todo`. A tool left out is missing from `tools/list` and refused when called. Applies to every client. Any other value stops startup |
| `CALDAV_MCP_TIME_ZONE` | the machine's zone | Your IANA time zone, like `Asia/Ho_Chi_Minh`. Whole-day dates and times written without a zone (`2026-10-12T09:00:00`) are read in it, both in stored tasks and events and in the `dueBefore`, `dateFrom` and `dateTo` filters; it decides what counts as overdue. Set it in a container, which usually runs in UTC. A name the runtime does not know stops startup |
| `PUBLIC_URL` | — | OAuth: the server's public origin, like `https://caldav-mcp.example.com`. The MCP endpoint is this plus `/mcp`. Set with the next two, or none of the three |
| `OWNER_PASSWORD_HASH` | — | OAuth: the hash of the password you type to approve a connector. Never the password itself; [how to make it](../README.md#use-it-from-claudeai) |
| `AUTH_PEPPER` | — | OAuth: a random secret of at least 32 characters the hash is made with. Changing it invalidates the hash |
| `OAUTH_KV_PATH` | `/data/oauth.kv` | OAuth: the Deno KV file that keeps grants and tokens across restarts. Its directory must exist and be writable; the server refuses to start otherwise |
| `TRUSTED_PROXIES` | — | Comma-separated CIDR ranges of the reverse proxies in front of HTTP mode, like `172.16.0.0/12` for a Docker network. `X-Forwarded-For` is read only from a peer inside them, so the rate limit counts each client behind the proxy separately. Empty trusts no one: any client could forge the header |

## HTTP mode

HTTP mode speaks Streamable HTTP on `/mcp`: each POST carries one JSON-RPC message or a batch and
gets a JSON answer, or `202` when it held only notifications. The answer to `initialize` carries an
`Mcp-Session-Id` header; the server keeps no state per session, so later requests work with or
without it. A `MCP-Protocol-Version` header the server does not speak gets `400`. `GET /mcp` gets
`405`: the server never starts a stream of its own.

`/health` needs no token. Every other route needs `MCP_BEARER_TOKEN` or, with OAuth on, an access
token from the OAuth flow (and the static token only with `ALLOW_BEARER_TOKEN_WITH_OAUTH=true`).
The static token is sent as one of:

- `Authorization: Bearer <token>`
- `Authorization: <token>`
- `X-Api-Key: <token>`

A token in the query string (`?api_key=`) is refused, because URLs end up in proxy and access logs.
A failed login is logged without the value the client sent, and every line written through the
logger has the token and the CalDAV password redacted.

A client is its IP address: the connecting peer, or the first `X-Forwarded-For` hop when the peer
is in `TRUSTED_PROXIES`. Each client may send 10 wrong tokens or refused consent forms per minute; after that every request
from it gets `429` with `Retry-After` until the minute is over, before its token is even checked.
Each client may also send 100 authorized requests per minute. A request body over 1 MiB gets `413`,
and a batch of more than 20 messages is refused whole.

A request to `/mcp` with an `Origin` header gets `403` unless the origin is `PUBLIC_URL`, so a web
page you visit cannot reach the server through your browser. Without `PUBLIC_URL` every `Origin` is
refused. Clients that are not browsers, Claude's among them, send no `Origin` and are not affected.

## OAuth

Set `PUBLIC_URL`, `OWNER_PASSWORD_HASH` and `AUTH_PEPPER` together and the server becomes its own
OAuth authorization server, so claude.ai and the Claude apps can connect to it as a remote
connector. Setting one or two of them stops startup with the names of the missing ones. The setup
is in the README, [Use it from claude.ai](../README.md#use-it-from-claudeai).

With OAuth on:

- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`
  describe the server; `/authorize` shows the consent page and `/token` hands out tokens.
- A request to `/mcp` without a valid token gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`.
- Only clients whose `client_id` is on `claude.ai` can sign in: the Claude apps and Claude Code.
  A `client_id` on any other host gets `400` before anything is fetched.
- Each client may open 10 consent pages a minute; the next one gets `429` until the minute is over.
- After 10 wrong owner passwords in 15 minutes from one client address, approvals from that address
  get `429` until the window ends; the right password from another address still works. After 100
  wrong passwords in 24 hours from all addresses together, every approval gets `429` until the
  oldest of them is a day old. The counts live in `OAUTH_KV_PATH`, so a restart does not reset them.
  Connectors already signed in keep working. So anyone who can reach the server, even from one
  address sending slowly, can block every approval for up to 24 hours, and longer if they keep
  sending; the README section [Use
  it from claude.ai](../README.md#use-it-from-claudeai) gives the recovery step (delete the key
  `["mcp-oauth", "attempts", "total"]` with the server stopped), and
  https://github.com/spy4x/ts-libs/issues/477 tracks a way in that the limit cannot block.
- Each grant ends 90 days after the owner approved it; refreshing its tokens does not extend it.
  `caldav-mcp grants list` shows the grants and `caldav-mcp grants revoke <grantId>` signs one
  out; see [Sign a connector out](../README.md#sign-a-connector-out).
- `MCP_BEARER_TOKEN` is refused: a request carrying it gets the same `401` and `WWW-Authenticate`
  as any wrong token, so nobody can tell whether one is set. Set
  `ALLOW_BEARER_TOKEN_WITH_OAUTH=true` to accept it next to OAuth, for clients such as OpenWebUI.
- Grants and tokens live in Deno KV at `OAUTH_KV_PATH`, so a restart keeps connectors signed in.
  The server runs with `--unstable-kv` for this (the tasks and the Docker image set it).
