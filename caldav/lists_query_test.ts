// ── Named calendar lists in the engine ──

import { assert, assertEquals } from 'std/assert/mod.ts'
import type { CalendarLists, EngineResult, EventSummary, TodoSummary } from './types.ts'
import { EVENTS, setup, TASKS } from './testing/fixtures.ts'
import { ORIGIN } from './testing/fake_caldav.ts'

const url = (path: string) => `${ORIGIN}${path}`

/** Engine options reading one fixed set of lists. */
const withLists = (lists: CalendarLists) => ({
  lists: () =>
    Promise.resolve({ success: true, output: lists, error: null } as EngineResult<CalendarLists>),
})

const perso: CalendarLists = { perso: [url(TASKS)] }

Deno.test('query_todos with a list reads only its calendars', async () => {
  const { engine } = setup(withLists(perso))
  const result = await engine.queryTodos({ list: 'perso' })
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output.total, 2)
  assertEquals(result.output.todos.every((t) => (t as TodoSummary).calendar === 'Inbox'), true)
})

Deno.test('query_events with a list reads only its calendars', async () => {
  const { engine } = setup(withLists({ work: [url(EVENTS)] }))
  const result = await engine.queryEvents({ list: 'work' })
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output.total, 1)
  assertEquals(result.output.events.every((e) => (e as EventSummary).calendar === 'Meetings'), true)
})

Deno.test('a list whose calendars hold no events answers empty', async () => {
  const { engine } = setup(withLists(perso))
  const result = await engine.queryEvents({ list: 'perso' })
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output.total, 0)
})

Deno.test('a list and a calendarUrl together are refused', async () => {
  const { engine } = setup(withLists(perso))
  for (
    const result of [
      await engine.queryTodos({ list: 'perso', calendarUrl: url(TASKS) }),
      await engine.queryEvents({ list: 'perso', calendarUrl: url(TASKS) }),
    ]
  ) {
    assertEquals(result.success, false)
    if (result.success) continue
    assertEquals(result.error.code, 'InvalidArgument')
  }
})

Deno.test('an unknown list is refused', async () => {
  const { engine } = setup(withLists(perso))
  const result = await engine.queryTodos({ list: 'work' })
  assertEquals(result.success, false)
  if (result.success) return
  assertEquals(result.error.code, 'UnknownList')
  assert(result.error.message.includes('work'))
})

Deno.test('a list naming a calendar that is no longer there is refused, naming it', async () => {
  const { engine } = setup(withLists({ ghost: [`${url(TASKS)}gone/`] }))
  const result = await engine.queryTodos({ list: 'ghost' })
  assertEquals(result.success, false)
  if (result.success) return
  assertEquals(result.error.code, 'UnknownCalendar')
  assert(result.error.message.includes('gone'))
})

Deno.test('without lists configured, every other list is refused with NoLists', async () => {
  const { engine } = setup()
  const result = await engine.queryEvents({ list: 'perso' })
  assertEquals(result.success, false)
  if (result.success) return
  assertEquals(result.error.code, 'NoLists')
})

Deno.test('the built-in list all reads every calendar, even without lists configured', async () => {
  const { engine } = setup()
  const events = await engine.queryEvents({ list: 'all' })
  assertEquals(events.success, true)
  if (!events.success) return
  assertEquals(events.output.total, 1)
  const todos = await engine.queryTodos({ list: 'all' })
  assertEquals(todos.success, true)
  if (!todos.success) return
  assertEquals(todos.output.total, 2)
})

Deno.test('the built-in list all ignores the lists file and keeps new calendars', async () => {
  const { engine } = setup(withLists({ all: [url(TASKS)] }))
  const result = await engine.queryEvents({ list: 'all' })
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output.total, 1)
  assertEquals(result.output.events.every((e) => (e as EventSummary).calendar === 'Meetings'), true)
})

Deno.test('listLists shows the members, a null displayName for a missing calendar', async () => {
  const { engine } = setup(withLists({ perso: [url(TASKS), `${url(TASKS)}gone/`] }))
  const result = await engine.listLists()
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output, [{
    name: 'all',
    all: true,
    calendars: [],
  }, {
    name: 'perso',
    calendars: [
      { url: url(TASKS), displayName: 'Inbox' },
      { url: `${url(TASKS)}gone/`, displayName: null },
    ],
  }])
})

Deno.test('listLists without lists configured answers the built-in all', async () => {
  const { engine } = setup()
  const result = await engine.listLists()
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output, [{ name: 'all', all: true, calendars: [] }])
})
