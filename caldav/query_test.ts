// ── Engine tests against an in-memory Stalwart-shaped server ──
// One regression test per CalDAV finding of the 2026-10-08 audit (spy4x/caldav-mcp#14) and #2.

import { assert, assertEquals, assertExists } from 'std/assert/mod.ts'
import { IcalDateKind } from '@spy4x/time/ical'
import { TodoStatus } from '@spy4x/time/ical-tasks'
import { HOME, ORIGIN } from './testing/fake_caldav.ts'
import {
  DONE_ETAG,
  DONE_PATH,
  EVENTS,
  lineDiff,
  MEETING,
  MEETING_ETAG,
  MEETING_PATH,
  setup,
  TASKS,
  TASKS_ORG,
  TASKS_ORG_ETAG,
  TASKS_ORG_PATH,
  ZONED,
  ZONED_ETAG,
  ZONED_PATH,
} from './testing/fixtures.ts'

const url = (path: string) => `${ORIGIN}${path}`

function unwrap<T>(result: { success: boolean; output: T | null; error: unknown }): T {
  if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  return result.output as T
}

Deno.test('renaming a Tasks.org task changes only SUMMARY and the edit stamps', async () => {
  const { fake, engine } = setup()
  unwrap(await engine.updateTodo(url(TASKS_ORG_PATH), TASKS_ORG_ETAG, { summary: 'Water it' }))
  const after = fake.objects.get(TASKS_ORG_PATH)!.data
  const diff = lineDiff(TASKS_ORG, after)
  const names = (lines: string[]) => lines.map((line) => line.split(/[;:]/)[0]).sort()
  assertEquals(names(diff.removed), ['DTSTAMP', 'LAST-MODIFIED', 'SUMMARY'])
  assertEquals(names(diff.added), ['DTSTAMP', 'LAST-MODIFIED', 'SUMMARY'])
  assert(diff.added.includes('SUMMARY:Water it'))
})

Deno.test('a date-only due date stays date-only and a zoned one keeps its zone', async () => {
  const { fake, engine } = setup()
  unwrap(await engine.updateTodo(url(TASKS_ORG_PATH), TASKS_ORG_ETAG, { priority: 1 }))
  unwrap(await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, { priority: 1 }))
  assert(fake.objects.get(TASKS_ORG_PATH)!.data.includes('\r\nDUE;VALUE=DATE:20261012\r\n'))
  assert(
    fake.objects.get(ZONED_PATH)!.data.includes(
      '\r\nDUE;TZID=Asia/Ho_Chi_Minh:20261008T090000\r\n',
    ),
  )
  const todo = unwrap(await engine.getTodo(url(TASKS_ORG_PATH)))
  assertEquals(todo.due, '2026-10-12')
  assertEquals(
    unwrap(await engine.getTodo(url(ZONED_PATH))).due,
    '2026-10-08T09:00:00[Asia/Ho_Chi_Minh]',
  )
})

Deno.test('a date-only task due today is not overdue, a past zoned one is', async () => {
  const { engine, fake } = setup()
  const today = TASKS_ORG.replace('DUE;VALUE=DATE:20261012', 'DUE;VALUE=DATE:20261009')
    .replace('DTSTART;VALUE=DATE:20261010', 'DTSTART;VALUE=DATE:20261008')
  fake.objects.set(TASKS_ORG_PATH, { etag: TASKS_ORG_ETAG, data: today })
  const result = unwrap(await engine.queryTodos({}))
  assertEquals(result.overdue, 1)
})

Deno.test("a reminder's text never becomes the task's description", async () => {
  const { engine } = setup()
  const todo = unwrap(await engine.getTodo(url(TASKS_ORG_PATH)))
  assertEquals(todo.description, undefined)
  assertEquals(todo.reminders, [{ action: 'DISPLAY', trigger: 'PT0S from end' }])
})

Deno.test('query_todos gives the server href and the etag with plain quotes', async () => {
  const { engine } = setup()
  const result = unwrap(await engine.queryTodos({}))
  const task = result.todos.find((t) => t.url === url(TASKS_ORG_PATH))
  assertExists(task, 'the task is addressed by the server href, not by its UID')
  assertEquals(task.etag, TASKS_ORG_ETAG)
})

Deno.test('an update with the etag from query_todos succeeds and is conditional', async () => {
  const { engine, fake } = setup()
  const listed = unwrap(await engine.queryTodos({}))
  const task = listed.todos.find((t) => t.url === url(TASKS_ORG_PATH))!
  const updated = unwrap(await engine.updateTodo(task.url, task.etag!, { priority: 2 }))
  const put = fake.requests.find((r) => r.method === 'PUT')!
  assertEquals(put.headers['if-match'], TASKS_ORG_ETAG)
  assertEquals(updated.etag, fake.objects.get(TASKS_ORG_PATH)!.etag)
})

Deno.test('get_todo returns the URL it was given, not one built from the UID', async () => {
  const { engine } = setup()
  const todo = unwrap(await engine.getTodo(url(TASKS_ORG_PATH)))
  assertEquals(todo.url, url(TASKS_ORG_PATH))
  assertEquals(todo.uid, '4417296204870311458')
})

Deno.test('the login goes only to the configured origin, never to a URL property', async () => {
  const { engine, fake } = setup()
  unwrap(await engine.queryTodos({}))
  unwrap(await engine.getTodo(url(TASKS_ORG_PATH)))
  unwrap(await engine.updateTodo(url(TASKS_ORG_PATH), TASKS_ORG_ETAG, { summary: 'x' }))
  unwrap(await engine.getEvent(url(MEETING_PATH)))
  const outside = await engine.getTodo('https://evil.example/steal')
  assertEquals(outside.success, false)
  const stolen = await engine.queryTodos({ calendarUrl: 'https://evil.example/cal/' })
  assertEquals(stolen.success, false)
  assert(fake.requests.length > 0)
  for (const request of fake.requests) assertEquals(new URL(request.url).origin, ORIGIN)
})

Deno.test('completing a one-off task sets COMPLETED and PERCENT-COMPLETE', async () => {
  const { engine, fake } = setup()
  const done = unwrap(
    await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, { status: TodoStatus.Completed }),
  )
  assertEquals(done.completion, 'completed')
  const data = fake.objects.get(ZONED_PATH)!.data
  assert(data.includes('\r\nSTATUS:COMPLETED\r\n'))
  assert(data.includes('\r\nCOMPLETED:20261009T100000Z\r\n'))
  assert(data.includes('\r\nPERCENT-COMPLETE:100\r\n'))
})

Deno.test('completing a repeating task moves it to the next week and keeps it open', async () => {
  const { engine, fake } = setup()
  const done = unwrap(
    await engine.updateTodo(url(TASKS_ORG_PATH), TASKS_ORG_ETAG, {
      status: TodoStatus.Completed,
    }),
  )
  assertEquals(done.completion, 'advanced')
  assertEquals(done.todo.status, 'NEEDS-ACTION')
  assertEquals(done.todo.due, '2026-10-19')
  assertEquals(done.todo.start, '2026-10-17')
  const data = fake.objects.get(TASKS_ORG_PATH)!.data
  assert(data.includes('\r\nRRULE:FREQ=WEEKLY;INTERVAL=1\r\n'))
  assert(!data.includes('\r\nCOMPLETED:'))
})

Deno.test('setting NEEDS-ACTION on a completed task reopens it', async () => {
  const { engine, fake } = setup()
  const reopened = unwrap(
    await engine.updateTodo(url(DONE_PATH), DONE_ETAG, { status: TodoStatus.NeedsAction }),
  )
  assertEquals(reopened.todo.status, 'NEEDS-ACTION')
  const data = fake.objects.get(DONE_PATH)!.data
  assert(!data.includes('COMPLETED:2026'))
  assert(!data.includes('PERCENT-COMPLETE:100'))
})

Deno.test('a delete without an etag is refused before any request', async () => {
  const { engine, fake } = setup()
  const result = await engine.deleteObject(url(TASKS_ORG_PATH), '')
  assertEquals(result.error?.code, 'InvalidArgument')
  assertEquals(fake.requests.filter((r) => r.method === 'DELETE'), [])
  assert(fake.objects.has(TASKS_ORG_PATH))
})

Deno.test('a delete with a stale etag is a Conflict and keeps the task', async () => {
  const { engine, fake } = setup()
  const result = await engine.deleteObject(url(TASKS_ORG_PATH), '"stale"')
  assertEquals(result.error?.code, 'Conflict')
  assert(fake.objects.has(TASKS_ORG_PATH))
})

Deno.test('delete_calendar refuses a URL that list_calendars does not return', async () => {
  const { engine, fake } = setup()
  const result = await engine.deleteCalendar(url(HOME))
  assertEquals(result.error?.code, 'UnknownCalendar')
  assertEquals(fake.requests.filter((r) => r.method === 'DELETE'), [])
  unwrap(await engine.deleteCalendar(url(EVENTS)))
  assert(!fake.calendars.has(EVENTS))
})

Deno.test('a category with an escaped comma stays one, and CATEGORIES lines merge', async () => {
  const { engine } = setup()
  const todo = unwrap(await engine.getTodo(url(TASKS_ORG_PATH)))
  assertEquals(todo.categories, ['home,garden', 'weekly'])
})

Deno.test('a long Cyrillic and emoji summary folds without splitting a character', async () => {
  const { engine, fake } = setup()
  const summary = 'Полить цветы на балконе и в спальне 🌱🌱🌱 '.repeat(4).trim()
  const created = unwrap(await engine.createTodo(url(TASKS), { summary }))
  const data = fake.objects.get(new URL(created.url).pathname)!.data
  for (const line of data.split('\r\n')) {
    assert(new TextEncoder().encode(line).length <= 75, `line over 75 octets: ${line}`)
  }
  assertEquals(unwrap(await engine.getTodo(created.url)).summary, summary)
})

Deno.test('a calendar URL that is not a calendar is an error, not an empty list', async () => {
  const { engine } = setup()
  const result = await engine.queryTodos({ calendarUrl: url(`${HOME}missing/`) })
  assertEquals(result.error?.code, 'UnknownCalendar')
})

Deno.test('a missing task is NotFound and a changed one is Conflict', async () => {
  const { engine } = setup()
  assertEquals((await engine.getTodo(url(`${TASKS}gone.ics`))).error?.code, 'NotFound')
  const stale = await engine.updateTodo(url(TASKS_ORG_PATH), '"old"', { summary: 'x' })
  assertEquals(stale.error?.code, 'Conflict')
})

Deno.test('a write the server answers without an etag reports the re-read etag', async () => {
  const { engine, fake } = setup()
  fake.sendEtagOnPut = false
  const updated = unwrap(await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, { priority: 3 }))
  assertEquals(updated.etag, fake.objects.get(ZONED_PATH)!.etag)
})

Deno.test('make_calendar creates under the calendar home, as Stalwart requires', async () => {
  const { engine, fake } = setup()
  const made = unwrap(await engine.makeCalendar('Probe', ['VTODO']))
  assert(made.url.startsWith(url(HOME)), made.url)
  const listed = unwrap(await engine.listCalendars())
  assertExists(listed.find((c) => c.url === made.url && c.displayName === 'Probe'))
  assertEquals(fake.calendars.size, 3)
})

Deno.test('parent, start, repeat rule and sort order can be set and fields cleared', async () => {
  const { engine } = setup()
  const updated = unwrap(
    await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, {
      parent: 'parent-uid',
      start: { kind: IcalDateKind.Utc, date: '2026-10-07', time: '01:00:00' },
      rrule: 'FREQ=DAILY',
      sortOrder: 7,
    }),
  )
  assertEquals(updated.todo.parent, 'parent-uid')
  assertEquals(updated.todo.rrule, 'FREQ=DAILY')
  assertEquals(updated.todo.sortOrder, 7)
  assertEquals(updated.todo.start, '2026-10-07T01:00:00Z')
  const cleared = unwrap(
    await engine.updateTodo(updated.url, updated.etag!, {
      parent: null,
      due: null,
      rrule: null,
      sortOrder: null,
    }),
  )
  assertEquals(cleared.todo.parent, undefined)
  assertEquals(cleared.todo.due, undefined)
  assertEquals(cleared.todo.rrule, undefined)
  assertEquals(cleared.todo.sortOrder, undefined)
})

Deno.test('changing the parent keeps links of other types', async () => {
  const { engine, fake } = setup()
  const sibling = ZONED.replace(
    'UID:zoned-task-uid',
    'UID:zoned-task-uid\r\nRELATED-TO;RELTYPE=SIBLING:sib-1',
  )
  fake.objects.set(ZONED_PATH, { etag: ZONED_ETAG, data: sibling })
  const updated = unwrap(await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, { parent: 'p-2' }))
  assertEquals(updated.todo.relatedTo, [
    { uid: 'sib-1', type: 'SIBLING' },
    { uid: 'p-2', type: 'PARENT' },
  ])
})

Deno.test('a new task gets the given UID and parent', async () => {
  const { engine } = setup()
  const created = unwrap(
    await engine.createTodo(url(TASKS), { summary: 'Child', parent: 'p-1' }, 'child-uid'),
  )
  assertEquals(created.uid, 'child-uid')
  const todo = unwrap(await engine.getTodo(created.url))
  assertEquals(todo.uid, 'child-uid')
  assertEquals(todo.parent, 'p-1')
})

Deno.test('query_todos is compact by default and lists open tasks only', async () => {
  const { engine } = setup()
  const result = unwrap(await engine.queryTodos({}))
  assertEquals(result.total, 2)
  for (const todo of result.todos) {
    assertEquals('description' in todo, false)
    assertEquals('categories' in todo, false)
  }
  const all = unwrap(await engine.queryTodos({ includeCompleted: true, detail: true }))
  assertEquals(all.total, 3)
  assertExists(all.todos.find((t) => 'description' in t && t.description === 'Bring two photos'))
})

Deno.test('query_todos honours limit and reports truncation', async () => {
  const { engine } = setup()
  const result = unwrap(await engine.queryTodos({ limit: 1 }))
  assertEquals(result.total, 2)
  assertEquals(result.todos.length, 1)
  assertEquals(result.truncated, true)
})

Deno.test('the text filter searches the description too', async () => {
  const { engine } = setup()
  const result = unwrap(await engine.queryTodos({ text: 'two PHOTOS', includeCompleted: true }))
  assertEquals(result.todos.map((t) => t.url), [url(DONE_PATH)])
})

Deno.test('get_todo reports the status by name', async () => {
  const { engine } = setup()
  assertEquals(unwrap(await engine.getTodo(url(DONE_PATH))).status, 'COMPLETED')
})

Deno.test('renaming an event keeps its repeat rule, guests, reminder and time zone', async () => {
  const { engine, fake } = setup()
  unwrap(await engine.updateEvent(url(MEETING_PATH), MEETING_ETAG, { summary: 'Team sync 2' }))
  const after = fake.objects.get(MEETING_PATH)!.data
  const diff = lineDiff(MEETING, after)
  const names = (lines: string[]) => lines.map((line) => line.split(/[;:]/)[0]).sort()
  assertEquals(names(diff.removed), ['DTSTAMP', 'SEQUENCE', 'SUMMARY'])
  assertEquals(names(diff.added), ['DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE', 'SUMMARY'])
})

Deno.test('a reminder text never becomes the event description', async () => {
  const { engine } = setup()
  const event = unwrap(await engine.getEvent(url(MEETING_PATH)))
  assertEquals(event.description, undefined)
  assertEquals(event.start, '2026-10-13T12:00:00[Europe/Berlin]')
})

Deno.test('a calendar that fails to list is reported, not shown as empty', async () => {
  const { engine, fake } = setup()
  const original = fake.fetch
  fake.fetch = (input, init) => {
    const request = new Request(input, init)
    return request.method === 'REPORT'
      ? Promise.resolve(new Response(null, { status: 500 }))
      : original(input, init)
  }
  const result = await engine.queryTodos({})
  assertEquals(result.error?.code, 'Server')
})

Deno.test('a calendar that fails while another answers is listed under failedCalendars', async () => {
  const { engine, fake } = setup()
  fake.calendars.set(`${HOME}work/`, { displayName: 'Work', components: ['VTODO'] })
  const original = fake.fetch
  fake.fetch = (input, init) => {
    const request = new Request(input, init)
    return request.method === 'REPORT' && new URL(request.url).pathname === TASKS
      ? Promise.resolve(new Response(null, { status: 500 }))
      : original(input, init)
  }
  const result = unwrap(await engine.queryTodos({}))
  assertEquals(result.total, 0)
  assertEquals(result.failedCalendars?.map((c) => c.url), [url(TASKS)])
})

Deno.test('task and event tools refuse a URL outside a listed calendar without sending it', async () => {
  const { engine, fake } = setup()
  const targets = [
    url(TASKS),
    url(`${TASKS}sub/`),
    url('/api/x'),
    url('/dav/principal/user%40example.com/'),
    url('/dav/cal/other%40example.com/tasks/theirs.ics'),
  ]
  unwrap(await engine.listCalendars())
  fake.requests.length = 0
  for (const target of targets) {
    assertEquals((await engine.deleteObject(target, '"anything"')).success, false, target)
    assertEquals((await engine.getTodo(target)).success, false, target)
    assertEquals((await engine.updateEvent(target, '"anything"', { summary: 'x' })).success, false)
  }
  assertEquals(fake.requests.filter((r) => targets.includes(r.url)), [])
  assert(fake.calendars.has(TASKS))
})

Deno.test('query_events sends the date range to the server', async () => {
  const { engine, fake } = setup()
  unwrap(
    await engine.queryEvents({
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
    }),
  )
  const report = fake.requests.find((r) => r.method === 'REPORT')!
  assert(
    /time-range start="20261001T000000Z" end="20261101T000000Z"/.test(report.body),
    report.body,
  )
})

Deno.test('the event text filter searches the location too', async () => {
  const { engine, fake } = setup()
  fake.objects.set(MEETING_PATH, {
    etag: MEETING_ETAG,
    data: MEETING.replace('SUMMARY:Team sync', 'SUMMARY:Team sync\r\nLOCATION:Room 4'),
  })
  const found = unwrap(await engine.queryEvents({ text: 'room 4' }))
  assertEquals(found.events.map((e) => e.url), [url(MEETING_PATH)])
  assertEquals(unwrap(await engine.queryEvents({ text: 'room 5' })).total, 0)
})

Deno.test('completing an already completed task keeps its completion date', async () => {
  const { engine, fake } = setup()
  const result = unwrap(
    await engine.updateTodo(url(DONE_PATH), DONE_ETAG, { status: TodoStatus.Completed }),
  )
  assertEquals(result.todo.status, 'COMPLETED')
  assert(fake.objects.get(DONE_PATH)!.data.includes('\r\nCOMPLETED:20261001T080000Z\r\n'))
})

Deno.test('renaming and completing in one call raises SEQUENCE once', async () => {
  const { engine, fake } = setup()
  unwrap(
    await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, {
      summary: 'Call the bank today',
      status: TodoStatus.Completed,
    }),
  )
  const data = fake.objects.get(ZONED_PATH)!.data
  assert(data.includes('\r\nSEQUENCE:1\r\n'), data)
})

Deno.test('an encoded path step, a backslash or a query in an item URL is refused unsent', async () => {
  const { engine, fake } = setup()
  const probes = [
    url(`${TASKS}..%2F..%2F..%2Fapi%2Fprincipal%2Fsomeone`),
    url(`${TASKS}..%5C..%5Capi%5Cx`),
    url(`${TASKS}x.ics?x=/api/principal`),
  ]
  unwrap(await engine.listCalendars())
  fake.requests.length = 0
  for (const probe of probes) {
    assertEquals((await engine.getTodo(probe)).error?.code, 'InvalidArgument', probe)
    assertEquals((await engine.deleteObject(probe, '"anything"')).error?.code, 'InvalidArgument')
  }
  assertEquals(fake.requests, [])
})

Deno.test('an update is written to the URL that was checked, not to where a read redirected', async () => {
  const { engine, fake } = setup()
  const moved = `${TASKS}moved.ics`
  fake.objects.set(moved, { etag: ZONED_ETAG, data: ZONED })
  const original = fake.fetch
  fake.fetch = (input, init) => {
    const request = new Request(input, init)
    if (request.method === 'GET' && new URL(request.url).pathname === ZONED_PATH) {
      return Promise.resolve(
        new Response(null, { status: 301, headers: { Location: url(moved) } }),
      )
    }
    return original(input, init)
  }
  unwrap(await engine.updateTodo(url(ZONED_PATH), ZONED_ETAG, { priority: 4 }))
  const puts = fake.requests.filter((r) => r.method === 'PUT').map((r) => r.url)
  assertEquals(puts, [url(ZONED_PATH)])
})
