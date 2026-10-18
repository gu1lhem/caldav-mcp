<div align="center">

# caldav-mcp

**Let your AI assistant read and manage your calendar and tasks on your own CalDAV server.**

[![CI](https://ci.antonshubin.com/api/badges/6/status.svg)](https://ci.antonshubin.com/repos/6)
[![MCP protocol](https://img.shields.io/badge/MCP-2025--06--18-blue)](https://modelcontextprotocol.io/specification/2025-06-18)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Tools and examples](https://github.com/spy4x/caldav-mcp/blob/main/docs/features.md) · [MCP clients](https://github.com/spy4x/caldav-mcp/blob/main/docs/clients.md) ·
[Self-hosting](https://github.com/spy4x/caldav-mcp/blob/main/docs/self-hosting.md) · [Configuration](https://github.com/spy4x/caldav-mcp/blob/main/docs/configuration.md) ·
[How it works](https://github.com/spy4x/caldav-mcp/blob/main/docs/how-it-works.md) · [FAQ](https://github.com/spy4x/caldav-mcp/blob/main/docs/faq.md)

<img src="docs/screenshots/tool-exchange.png" alt="An example request, &quot;Book a 30-minute call with Jane Doe on Friday at 10:00 UTC, remind me to send her the agenda the day before, and show me what's still open&quot;, followed by four real tool calls and their responses: list_calendars returns the personal and work calendars, create_event adds &quot;Call with Jane Doe&quot; to work, create_todo adds &quot;Send the agenda to Jane&quot; with priority 1, and query_todos returns two open tasks, one of them overdue." width="820">

</div>

caldav-mcp is a [Model Context Protocol](https://modelcontextprotocol.io/) server. Connect it to
Claude Desktop, OpenCode, Cursor, OpenWebUI or any other MCP client, and your assistant can list
your calendars, find events and tasks, and create, update or delete them on your own CalDAV
server. The request in the picture is an example. The four tool calls were sent by hand, the way an
assistant would make them, and every response is what caldav-mcp returned from a local Radicale
server.

I wrote it because the CalDAV MCP servers I tried hid tasks, could not search across calendars,
and pulled in a large npm install. I run it on my own homelab next to my calendar server.

## Why caldav-mcp

- **Events and tasks, both first-class.** Full create, read, update and delete for events
  (VEVENT) and tasks (VTODO), with ETags so two edits never overwrite each other silently.
- **One call searches every calendar.** The calendar is optional on every query, so "what is
  overdue?" is one request, not one per calendar.
- **Answers an assistant can use.** Queries return totals, counts by status and priority and the
  number of overdue tasks next to the list, capped at 200 items with a `truncated` flag.
- **Built on web standards.** Modern TypeScript on Fetch, Web Crypto, Streams and ES modules,
  plus pinned libraries from JSR and npm, such as Hono and ArkType for the OAuth routes. No `npm
  install` and no `node_modules`: it runs on Deno 2, which downloads them by itself.
- **Runs where you want it.** Straight from a pinned JSR release, as one compiled binary, or as the
  Docker image `antonshubin/caldav-mcp`. Docker and systemd setups are in
  [self-hosting.md](https://github.com/spy4x/caldav-mcp/blob/main/docs/self-hosting.md).
- **Narrow permissions.** It needs network access to your CalDAV server and to read its own
  settings, nothing else: no files and no subprocesses. OAuth adds access to its own token store.
- **Local or remote.** stdio for desktop clients, or Streamable HTTP with a bearer token or OAuth
  for claude.ai, the Claude phone app, OpenWebUI and other networked clients.

**Use it if** your calendar lives on a CalDAV server you can reach with a username and password.
I run it every day against Stalwart, and the exchange in the picture ran against Radicale. It
signs in with HTTP Basic auth only, so a server set to Digest auth, such as Baïkal by default,
needs Basic turned on. Other servers are not tested yet; please open an issue if one does not
work. **Skip it if** you need Google Calendar (Google offers CalDAV only behind OAuth 2.0, which
caldav-mcp does not speak), contacts (CardDAV) or several users from one instance. The comparison
with `dav-mcp` is in [how-it-works.md](https://github.com/spy4x/caldav-mcp/blob/main/docs/how-it-works.md#comparison).

## Quick start

Install [Deno](https://deno.com), then add this to Claude Desktop's `claude_desktop_config.json`.
Replace `cal.example.com` in `--allow-net` with the host of your `CALDAV_URL`.

```json
{
  "mcpServers": {
    "caldav": {
      "command": "deno",
      "args": [
        "run",
        "--allow-net=cal.example.com",
        "--allow-env=CALDAV_URL,CALDAV_SERVER_URL,CALDAV_USERNAME,CALDAV_PASSWORD,CALDAV_MCP_TOOLS,CALDAV_MCP_TIME_ZONE,HOST,PORT,LOG_LEVEL,MCP_BEARER_TOKEN,ALLOW_BEARER_TOKEN_WITH_OAUTH,TRUSTED_PROXIES,PUBLIC_URL,OWNER_PASSWORD_HASH,AUTH_PEPPER,OAUTH_KV_PATH",
        "jsr:@spy4x/caldav-mcp@1.6.0"
      ],
      "env": {
        "CALDAV_URL": "https://cal.example.com",
        "CALDAV_USERNAME": "user",
        "CALDAV_PASSWORD": "pass"
      }
    }
  }
}
```

Restart Claude Desktop and ask "Which calendars do I have?". The answer comes from
`list_calendars`. OpenCode, OpenWebUI and Cursor are in
[clients.md](https://github.com/spy4x/caldav-mcp/blob/main/docs/clients.md).

The version is pinned, so the code you run never changes under you; move to a newer release by
changing `@1.6.0`. The two permissions are all it needs: `--allow-net` lets it reach your CalDAV
server and nothing else, and `--allow-env` lets it read only the settings in
[configuration.md](https://github.com/spy4x/caldav-mcp/blob/main/docs/configuration.md). It
reads and writes no files and starts no programs. If your server sends clients on to another host,
add that host to `--allow-net` too, separated by a comma.

## Configuration

The ones you must set:

| Variable          | Example                   |
| ----------------- | ------------------------- |
| `CALDAV_URL`      | `https://cal.example.com` |
| `CALDAV_USERNAME` | `user`                    |
| `CALDAV_PASSWORD` | `pass`                    |

The HTTP port, the bearer token, OAuth, the log level, `CALDAV_MCP_TOOLS` and your time zone
(`CALDAV_MCP_TIME_ZONE`) are optional: see
[configuration.md](https://github.com/spy4x/caldav-mcp/blob/main/docs/configuration.md).
Every variable is listed with a placeholder in [`.env.example`](.env.example).

## Use it from claude.ai

claude.ai, Claude Desktop and the Claude phone app can use caldav-mcp as a remote connector. They
sign in with OAuth, and you approve each one with your own password.

**1. Give it a public HTTPS address.** claude.ai connects from the internet, so the server needs a
URL such as `https://caldav-mcp.example.com`, usually a reverse proxy (Traefik, Caddy, nginx) that
terminates TLS in front of the container. Set `TRUSTED_PROXIES` to the proxy's network so the rate
limit sees each client's own address.

**2. Make the owner password hash.** Use a long random owner password, for example 24 or more
characters from a password manager. After 10 wrong passwords in 15 minutes from one address, or 100
in a day from all addresses together, the server stops accepting approvals for a while, so guessing
is slow, but a long password is what keeps it safe. Pick a pepper, a random secret of at least 32
characters, for example `openssl rand -base64 48`. Then hash your password with it, from a checkout
of this repository. Both the pepper and the password are read without echoing, so neither lands in
your shell history:

```bash
read -rs AUTH_PEPPER && export AUTH_PEPPER   # paste the pepper; it is not echoed
deno task password:hash
unset AUTH_PEPPER
```

**3. Set the env vars and start it in HTTP mode.**

| Variable              | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| `PUBLIC_URL`          | The public origin, `https://caldav-mcp.example.com`, no path |
| `OWNER_PASSWORD_HASH` | The `pbkdf2-sha256$…` line step 2 printed                   |
| `AUTH_PEPPER`         | The pepper from step 2                                      |
| `OAUTH_KV_PATH`       | Optional. Where tokens are kept; default `/data/oauth.kv`   |
| `HOST`                | `0.0.0.0` in a container                                    |
| `CALDAV_MCP_TOOLS`    | Optional. `no-delete` or `read-only`; default `all`         |

Set all three OAuth variables or none: with one or two the server refuses to start and names the
missing ones. With OAuth on, `/mcp` refuses `MCP_BEARER_TOKEN` and answers it like any wrong token,
so a public server cannot be entered with a leaked static token; leave it unset there. A server that
also serves clients with the static token, such as OpenWebUI, must say so with
`ALLOW_BEARER_TOKEN_WITH_OAUTH=true`.

Every connector that signs in gets every tool the server offers; the server has no per-connector
scopes. A stolen token for a full server could delete every calendar and every task in the account.
`CALDAV_MCP_TOOLS=no-delete` leaves `delete_calendar`, `delete_event` and `delete_todo` out of the
tool list and refuses calls to them; `read-only` also leaves out every tool that creates or changes
something. `no-delete` still allows `update_event` and `update_todo`, which can overwrite the
content of any event or task; only `read-only` stops a stolen token from changing data. The setting
applies to every client of that server. Any other value stops startup.

The server keeps grants and tokens in a Deno KV file, `/data/oauth.kv` by default, so mount a
writable volume at `/data` (`compose.yml` does). Its directory must exist: if the file cannot be
opened, the server refuses to start and names the path.

**4. Add the connector.** In claude.ai open Settings → Connectors → Add custom connector, and enter
the URL with `/mcp` on the end: `https://caldav-mcp.example.com/mcp`. Leave the OAuth client ID and
secret empty.

**5. Sign in.** Claude opens a consent page on your server. It shows who is asking and where the
approval goes (`claude.ai`). Type your owner password and press **Allow**. A wrong password shows
the page again with "Wrong password. Try again." After 10 wrong passwords in 15 minutes from one
address, approvals from that address get `429` until the 15 minutes are over, while your own
address can still approve; after 100 in a day from all addresses together, every approval gets
`429` for a while. Connectors already signed in keep working. Claude then lists the tools, and the
connector works in the Claude apps on every device signed in to your account. A restart or a
redeploy keeps it signed in. Each sign-in lasts 90 days from your approval; after that, Claude
asks you to sign in again.

Never approve a consent page you did not open yourself, even one on your own server: someone else
can start a sign-in and send you its link. If you did approve one, run `caldav-mcp grants list` and
revoke any grant you do not recognise with `caldav-mcp grants revoke <grantId>` (see
[Sign a connector out](#sign-a-connector-out)).

Anyone who can reach the server can still keep you from approving a connector. 100 wrong passwords
in a day from all addresses together block every approval for up to 24 hours, and one address can
send them slowly enough to stay under its own limit. The block lasts as long as they keep sending,
and a restart does not lift it.
Connectors already signed in keep working. To approve anyway, block those addresses, stop the
server and delete the server-wide count from the OAuth store, then start it again:

```bash
deno eval --unstable-kv '
  const kv = await Deno.openKv("oauth.kv")
  await kv.delete(["mcp-oauth", "attempts", "total"])
  kv.close()'
```

Run it with `oauth.kv` replaced by the path to that file where you run it. The container image has
no `deno`, so run it on the host against the file in the data volume, as a user who can write it.
A way in that this limit cannot block is
planned in https://github.com/spy4x/ts-libs/issues/477.

### Sign a connector out

If a device with Claude signed in is lost, or you no longer trust a connector, revoke its grant.
Run the command where the server runs, for example in its container:

```bash
docker exec <container> caldav-mcp grants list           # one line per signed-in connector
docker exec <container> caldav-mcp grants revoke <grantId>
```

`list` prints each grant's id, the client's host, when you approved it and when it ends. `revoke`
signs that one connector out at once and keeps every other one signed in; it works while the
server runs. From a checkout, `deno task grants list` does the same, reading `OAUTH_KV_PATH`.

A connector approved before version 1.3.0 has no grant record until it next refreshes its token,
which it does the first time it is used after its 15-minute access token runs out. If you need to
sign it out before then, sign out everything: stop the server, delete the `oauth.kv` file (and its
`-shm` and `-wal` files), and start it again. Every connector then asks you to sign in again.

## Development

```bash
git clone https://github.com/spy4x/caldav-mcp.git && cd caldav-mcp
CALDAV_URL=... CALDAV_USERNAME=... CALDAV_PASSWORD=... deno task dev   # hot reload
deno task check && deno task test
deno task compile   # single binary: ./caldav-mcp
```

The code layout is in [how-it-works.md](https://github.com/spy4x/caldav-mcp/blob/main/docs/how-it-works.md#architecture).

## Built by

I'm [Anton Shubin](https://antonshubin.com), a senior full-stack engineer and tech lead.
caldav-mcp is one of the tools I build and run on my own servers, and building MCP servers and AI
integrations is part of my client work. Need something like it built for your product?
[That's my day job →](https://antonshubin.com)

Licensed under [MIT](LICENSE). Copyright (c) 2026 Anton Shubin.

---

Made by Anton Shubin · [antonshubin.com/tools/caldav-mcp](https://antonshubin.com/tools/caldav-mcp)
