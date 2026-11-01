// ── Named calendar lists in the engine ──

import { assert, assertEquals } from 'std/assert/mod.ts'
import type { CalendarLists, EngineResult, EventSummary, TodoSummary } from './types.ts'
import {
  addSubscription,
  EVENTS,
  HOLIDAYS,
  HOLIDAYS_NAME,
  setup,
  TASKS,
} from './testing/fixtures.ts'
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

Deno.test('without lists configured, every list is refused with NoLists', async () => {
  const { engine } = setup()
  const result = await engine.queryEvents({ list: 'perso' })
  assertEquals(result.success, false)
  if (result.success) return
  assertEquals(result.error.code, 'NoLists')
})

Deno.test('listLists shows the built-in all first, then the members', async () => {
  const { engine } = setup(withLists({ perso: [url(TASKS), `${url(TASKS)}gone/`] }))
  const result = await engine.listLists()
  assertEquals(result.success, true)
  if (!result.success) return
  const [builtin, ...named] = result.output
  assertEquals(builtin!.name, 'all')
  const displayNames = builtin!.calendars.map((c) => c.displayName)
  assert(displayNames.includes('Inbox'))
  assert(displayNames.includes('Meetings'))
  assertEquals(named, [{
    name: 'perso',
    calendars: [
      { url: url(TASKS), displayName: 'Inbox' },
      { url: `${url(TASKS)}gone/`, displayName: null },
    ],
  }])
})

Deno.test('the built-in all reads every calendar, including one added later', async () => {
  const { fake, engine } = setup(withLists({ perso: [url(TASKS)] }))
  addSubscription(fake)
  const result = await engine.queryEvents({ list: 'all' })
  assertEquals(result.success, true)
  if (!result.success) return
  const names = result.output.events.map((e) => (e as EventSummary).calendar)
  assert(names.includes('Meetings'), 'Meetings')
  assert(names.includes(HOLIDAYS_NAME), HOLIDAYS_NAME)
  // a list made before the subscription still knows only its own calendars
  const persoResult = await engine.queryEvents({ list: 'perso' })
  assertEquals(persoResult.success, true)
  if (!persoResult.success) return
  assertEquals(persoResult.output.total, 0)
})

Deno.test('the built-in all leaves a subscription out of todos', async () => {
  const { fake, engine } = setup(withLists({ perso: [url(TASKS)] }))
  addSubscription(fake)
  const result = await engine.queryTodos({ list: 'all' })
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(
    result.output.todos.every((t) => (t as TodoSummary).calendar === 'Inbox'),
    true,
  )
})

Deno.test('listLists without lists configured answers empty', async () => {
  const { engine } = setup()
  const result = await engine.listLists()
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output, [])
})

Deno.test('a list with a subscription serves its events', async () => {
  const { fake, engine } = setup(withLists({ feeds: [url(HOLIDAYS)] }))
  addSubscription(fake)
  const result = await engine.queryEvents({ list: 'feeds' })
  assertEquals(result.success, true)
  if (!result.success) return
  assert(result.output.total > 0)
  assertEquals(
    result.output.events.every((e) => (e as EventSummary).calendar === HOLIDAYS_NAME),
    true,
  )
})

Deno.test('a list with a subscription answers no todos: VTODO skips it', async () => {
  const { fake, engine } = setup(withLists({ feeds: [url(HOLIDAYS)] }))
  addSubscription(fake)
  const result = await engine.queryTodos({ list: 'feeds' })
  assertEquals(result.success, true)
  if (!result.success) return
  assertEquals(result.output.total, 0)
})
