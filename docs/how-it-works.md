# How it works

Why caldav-mcp exists, how it compares with `dav-mcp`, and how the code is laid out.

## Why caldav-mcp?

Existing CalDAV MCP servers (like `dav-mcp`) ship as npm packages that depend on `tsdav` — a library with unfixed bugs:

| Bug | Symptom |
|-----|---------|
| Wrong method names | `client.createTodo()` doesn't exist in tsdav → runtime crash |
| Broken VTODO filtering | Defaults to VEVENT only, tasks are invisible |
| Cross-calendar search | Not supported — must query each calendar manually |
| npm + npx overhead | ~200MB+ download, runtime patches with `sed` |

**caldav-mcp** is a from-scratch implementation that fixes all of this. No wrappers, no workarounds.

## Comparison

| | `dav-mcp` (npm) | **caldav-mcp** |
|---|---|---|
| **Runtime** | Node.js + npx | **Static binary (Deno)** |
| **Dependencies** | tsdav, mcpo, npx | **Zero** |
| **Install size** | ~200MB | **~89MB** |
| **Startup time** | 3-5s (npx resolve) | **<100ms** |
| **VTODO support** | ❌ Broken (patched with sed) | **✅ First-class** |
| **VEVENT support** | ⚠️ Partial | **✅ Full CRUD** |
| **Cross-calendar search** | ❌ No | **✅ One query = all calendars** |
| **Summarization** | ❌ Raw iCal | **✅ byStatus/byPriority/overdue** |
| **Task relationships** | ❌ No | **✅ RELATED-TO (parent/child/sibling)** |
| **HTTP transport** | Via mcpo proxy | **✅ Native JSON-RPC over POST** |
| **Memory** | ~512MB | **~64MB** |
| **License** | GPL-3.0 | **MIT** |

## Architecture

```
┌──────────────┐    stdio/HTTP    ┌──────────────┐    PROPFIND/REPORT    ┌──────────┐
│  MCP Client   │ ◄────────────► │  caldav-mcp  │ ◄──────────────────► │  CalDAV  │
│  (Claude/     │   JSON-RPC 2.0  │   (Deno)     │    PUT/DELETE/MKCOL    │  Server  │
│   OpenCode/   │                 │   89MB bin   │                       │(Radicale)│
│   OpenWebUI)  │                 │   ~64MB RAM  │                       │          │
└──────────────┘                  └──────────────┘                       └──────────┘
```

### Project Structure

```
caldav-mcp/
├── main.ts           # Entry: stdio + Streamable HTTP transports
├── mcp.ts            # MCP protocol (JSON-RPC 2.0, versions 2024-11-05 to 2025-06-18)
├── oauth.ts          # OAuth for remote connectors, on @spy4x/server/mcp-oauth
├── grants.ts         # `caldav-mcp grants`: list and revoke OAuth grants
├── env.ts            # Config from environment variables
├── caldav/
│   ├── query.ts      # Query engine on @spy4x/caldav + @spy4x/time/ical-tasks
│   ├── dates.ts      # Date text in tool arguments and answers
│   ├── types.ts      # Shapes the tools return
│   └── testing/      # In-memory Stalwart-shaped server and fixtures for tests
├── tools/
│   ├── calendars.ts  # list_calendars, make_calendar, delete_calendar
│   ├── todos.ts      # CRUD for VTODO
│   ├── events.ts     # CRUD for VEVENT
│   └── args.ts       # Argument checks; a bad argument is an isError result
├── Dockerfile        # Multistage → distroless (89MB)
└── deno.jsonc
```

## Why Deno?

| Requirement | Node.js | Deno |
|-------------|---------|------|
| TypeScript | ❌ Needs tsconfig + transpiler | **✅ Native** |
| fetch() | ❌ Needs axios/undici | **✅ Built-in** |
| File I/O | ❌ Needs fs/promises | **✅ Native** |
| Binary compile | ❌ Needs pkg/ncc | **✅ deno compile** |
| Standard library | ❌ npm chaos | **✅ deno.land/std** |
