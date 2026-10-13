# Tools and examples

Every tool caldav-mcp offers, what its answers look like, and example calls. Back to the
[README](../README.md).

## MCP Tools

| Tool | What it does | Why AI loves it |
|------|-------------|-----------------|
| `query_todos` | Search tasks across ALL calendars | **`calendarUrl` is optional** — one call, all data |
| `query_events` | Search events across ALL calendars | Same — cross-calendar by default |
| `list_calendars` | List all calendars + component types | Auto-discovers structure |
| `create_todo` / `update_todo` / `delete_todo` | Full task CRUD | ETag-based concurrency |
| `create_event` / `update_event` / `delete_event` | Full event CRUD | Same pattern |
| `get_todo` / `get_event` | Single item by URL | Read-back for verification |
| `make_calendar` | Create a calendar collection | AI can organize projects |
| `delete_calendar` | Delete a calendar collection and all its events/todos | Cleans up after a project |

## AI-First Design

Every query returns **counts first, then a compact list**. By default `query_todos` lists open
tasks only, at most 50, with the fields an assistant needs to pick one; pass `detail: true` for
every field, `includeCompleted: true` for finished tasks too, and `limit` (up to 200) for more.

```json
{
  "total": 118,
  "byStatus": { "NEEDS-ACTION": 118 },
  "byPriority": { "high": 33, "medium": 51, "low": 8, "none": 26 },
  "overdue": 11,
  "truncated": true,
  "todos": [
    {
      "url": "https://cal.example.com/dav/cal/me/tasks/AB12CD34-9999.ics",
      "etag": "\"424081823\"",
      "summary": "Review PR",
      "status": "NEEDS-ACTION",
      "priority": 2,
      "due": "2026-10-12",
      "repeats": true,
      "calendar": "Work"
    }
  ]
}
```

- `url` is the address the server gave the task, and `etag` is the server's value, quotes
  included. Pass both back unchanged to edit or delete.
- Dates keep their kind: `2026-10-12` (a whole day), `2026-10-12T09:00:00Z` (UTC),
  `2026-10-12T09:00:00` (floating wall-clock time) or `2026-10-12T09:00:00[Asia/Ho_Chi_Minh]`
  (wall-clock time in a zone). Tool arguments accept the same forms, plus an offset such as
  `2026-10-12T09:00+07:00`, which is stored as UTC. A whole day and a floating time are read in
  `CALDAV_MCP_TIME_ZONE` ([configuration.md](configuration.md)).
- If one calendar cannot be read, the answer lists it under `failedCalendars` instead of showing
  it as empty. Objects that cannot be parsed are counted under `unreadable`.

## Safe edits

- **Only what you change is written.** `update_todo` and `update_event` change the fields you
  pass and keep every other line: reminders, repeat rules, guests, time zones and the lines
  other apps add.
- **`null` clears a field**, for example `{"due": null}`. Leaving a field out keeps it.
- **Every write is conditional.** Updates and deletes need the etag you read; if someone changed
  the item since, the answer is an error with code `Conflict` and a hint to re-read and retry.
- **Completing works like Tasks.org.** `status: "COMPLETED"` on a repeating task moves it to its
  next date and the answer says `"completion": "advanced"`; a one-off task is marked done
  (`"completed"`). Setting an open status on a done task reopens it.
- **Errors are errors.** A bad argument or a server refusal comes back as an MCP error result
  (`isError`) with a `code` such as `Conflict`, `NotFound` or `InvalidArgument`.
- **Your login stays home.** The username and password go only to the configured server. Task
  and event tools accept only an item directly inside a calendar `list_calendars` returns, so
  they never read, change or delete a whole calendar, a principal or another user's data.

## Task Relationships (RFC 5545 RELATED-TO)

`get_todo` (or `query_todos` with `detail: true`) shows a task's `parent` UID and every other
link under `relatedTo`. Set or clear the parent with `parent` on `create_todo` and `update_todo`;
links of other types are kept.

```
get_todo → { "summary": "Fix auth bug", "uid": "fix-auth-bug-123", "parent": "deploy-v2-456" }
update_todo({ url, etag, parent: null })   → the task is no longer a subtask
```

Reminders (VALARM) are shown under `reminders`. `create_todo`, `update_todo`, `create_event` and
`update_event` take an `alarms` list to set them:

```json
{ "alarms": [{ "before": "PT1H" }, { "at": "2026-10-12T08:00:00Z" }] }
```

- **`before`** is an ISO 8601 duration (`PT15M`, `PT1H`, `P1D`, `PT0S` for "at the time"). On a task
  it counts from the **due** time, the "before due" reminder Tasks.org shows, so the task needs a
  due date. On an event it counts from the **start**.
- **`at`** is a fixed moment in UTC.
- **The list replaces every reminder.** A reminder that is already there and equal is kept byte
  for byte, with the lines other apps added to it. `null` removes all of them. Leaving `alarms`
  out keeps them.
- Writing a new reminder the task or event has no date for is refused with a message naming the
  missing date, and nothing is written. Removing the date later (`{"due": null}`) is allowed and
  leaves the reminders already there in place.
- **`at`** also accepts a time with an offset (`+07:00`); it is converted to UTC.

## Examples

### Filtering

```
query_todos({})                                    → open tasks, counts and a compact list
query_todos({includeCompleted: true})              → finished tasks too
query_todos({status: "IN-PROCESS"})                → only this status
query_todos({priority: {min: 1, max: 3}})          → high-priority open tasks
query_todos({dueBefore: "2026-10-09T10:00:00Z"})   → due before then
query_todos({text: "upwork", detail: true})        → text in summary or description, all fields
query_events({dateFrom: "2026-10-01", dateTo: "2026-10-31"}) → events in a date range
query_events({text: "meeting"})                    → events containing "meeting"
```

### Full CRUD

```json
create_todo({
  "calendarUrl": "https://cal.example.com/dav/cal/me/tasks/",
  "summary": "Write documentation",
  "description": "Cover API endpoints, config, and deployment",
  "priority": 2,
  "start": "2026-10-10",
  "due": "2026-10-12",
  "rrule": "FREQ=WEEKLY;BYDAY=MO",
  "parent": "deploy-v2-456"
})
→ {"url": "https://.../<uuid>.ics", "etag": "\"...\"", "uid": "<uuid>"}
```
