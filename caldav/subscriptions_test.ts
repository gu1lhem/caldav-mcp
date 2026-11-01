// Calendar subscriptions: listed, read through the server's `?export`, never written.

import { assert, assertEquals } from 'std/assert/mod.ts'
import { TodoStatus } from '@spy4x/time/ical-tasks'
import { HOME, ORIGIN } from './testing/fake_caldav.ts'
import {
  addSubscription,
  BIRTHDAY_UID,
  BIRTHDAY_URL,
  EVENTS,
  HOLIDAYS,
  MEETING_ETAG,
  MEETING_PATH,
  setup,
} from './testing/fixtures.ts'

const url = (path: string) => `${ORIGIN}${path}`

function unwrap<T>(result: { success: boolean; output: T | null; error: unknown }): T {
  if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  return result.output as T
}

/** The requests sent, apart from re-reading the calendar list (a PROPFIND of the home). */
function sentBesidesList(fake: ReturnType<typeof setup>['fake']): string[] {
  return fake.requests.filter((r) => !(r.method === 'PROPFIND' && r.url === url(HOME)))
    .map((r) => `${r.method} ${r.url}`)
}

function withSubscription(feed?: string) {
  const made = setup()
  addSubscription(made.fake, feed)
  return made
}

Deno.test('list_calendars marks a subscription and leaves normal calendars unmarked', async () => {
  const { engine } = withSubscription()
  const calendars = unwrap(await engine.listCalendars())
  assertEquals(calendars.find((c) => c.url === url(HOLIDAYS))?.subscribed, true)
  assertEquals(calendars.find((c) => c.url === url(EVENTS))?.subscribed, undefined)
})

Deno.test('query_events reads a subscription by its export and applies the time range', async () => {
  const { engine, fake } = withSubscription()
  const found = unwrap(
    await engine.queryEvents({
      calendarUrl: url(HOLIDAYS),
      from: new Date('2026-10-15T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
    }),
  )
  // The yearly birthday is in range by its 2026 instance; the event whose zone is unknown is
  // kept, since its time cannot be checked; the November match is left out.
  assertEquals(
    found.events.map((e) => e.summary).sort(),
    ['Ann turns older', 'Harvest day', 'Somewhere else'],
  )
  const reads = fake.requests.filter((r) => r.method === 'GET')
  assertEquals(reads.map((r) => r.url), [`${url(HOLIDAYS)}?export`])
})

Deno.test("query_events applies the text filter to a subscription's events", async () => {
  const { engine } = withSubscription()
  const found = unwrap(await engine.queryEvents({ calendarUrl: url(HOLIDAYS), text: 'stadium' }))
  assertEquals(found.events.map((e) => e.summary), ['Match day'])
})

Deno.test('get_event reads a subscription event by its #uid url', async () => {
  const { engine } = withSubscription()
  const event = unwrap(await engine.getEvent(BIRTHDAY_URL))
  assertEquals(event.uid, BIRTHDAY_UID)
  assertEquals(event.url, BIRTHDAY_URL)
  assertEquals(event.etag, null)
  assertEquals(event.calendarUrl, url(HOLIDAYS))
})

Deno.test('a #uid url on a normal calendar is refused, with nothing sent but the calendar list', async () => {
  const { engine, fake } = withSubscription()
  unwrap(await engine.listCalendars())
  fake.requests.length = 0
  const got = await engine.getEvent(`${url(EVENTS)}#meeting-uid`)
  assertEquals(got.error?.code, 'InvalidArgument')
  assertEquals(sentBesidesList(fake), [])
})

Deno.test('every write to a subscription is refused as read-only, with nothing sent but the calendar list', async () => {
  const { engine, fake } = withSubscription()
  unwrap(await engine.listCalendars())
  fake.requests.length = 0
  const sub = url(HOLIDAYS)
  const attempts = {
    createEvent: await engine.createEvent(sub, { summary: 'x' }),
    createTodo: await engine.createTodo(sub, { summary: 'x' }),
    updateEvent: await engine.updateEvent(BIRTHDAY_URL, '"1"', { summary: 'x' }),
    updateTodo: await engine.updateTodo(BIRTHDAY_URL, '"1"', { status: TodoStatus.Completed }),
    deleteEvent: await engine.deleteObject(BIRTHDAY_URL, '"1"'),
    deleteByPath: await engine.deleteObject(`${sub}plain.ics`, '"1"'),
    deleteCalendar: await engine.deleteCalendar(sub),
  }
  for (const [name, result] of Object.entries(attempts)) {
    assertEquals(result.error?.code, 'ReadOnly', name)
    assert(result.error?.message.includes('Holidays'), name)
  }
  assertEquals(sentBesidesList(fake), [])
})

Deno.test('a normal calendar beside a subscription can still be written', async () => {
  const { engine } = withSubscription()
  const updated = await engine.updateEvent(url(MEETING_PATH), MEETING_ETAG, { summary: 'Renamed' })
  assertEquals(updated.error, null)
})

Deno.test('query_todos leaves subscriptions out', async () => {
  const { engine, fake } = withSubscription()
  unwrap(await engine.queryTodos({}))
  assertEquals(fake.requests.filter((r) => r.url.includes('?export')), [])
  const one = await engine.queryTodos({ calendarUrl: url(HOLIDAYS) })
  assertEquals(one.error?.code, 'InvalidArgument')
})

Deno.test('a subscription whose export fails is one failed calendar, not a failed query', async () => {
  const { engine } = withSubscription('not iCalendar')
  const found = unwrap(await engine.queryEvents({}))
  assertEquals(found.events.map((e) => e.summary), ['Team sync'])
  assertEquals(found.failedCalendars?.map((f) => [f.url, f.code]), [[url(HOLIDAYS), 'Malformed']])
})
