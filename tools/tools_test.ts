// ── Tool tests through the MCP handler ──

import { assert, assertEquals, assertMatch } from 'std/assert/mod.ts'
import { UUID_V7_PATTERN } from '@spy4x/platform/universal/uuid'
import type { EngineOptions } from '../caldav/query.ts'
import { McpHandler } from '../mcp.ts'
import { registerAllTools, type ToolMode } from './index.ts'
import { ORIGIN } from '../caldav/testing/fake_caldav.ts'
import {
  EVENTS,
  lineDiff,
  MEETING,
  MEETING_ETAG,
  MEETING_PATH,
  setup,
  TASKS,
  TASKS_ORG_ETAG,
  TASKS_ORG_PATH,
  ZONED,
  ZONED_ETAG,
  ZONED_PATH,
} from '../caldav/testing/fixtures.ts'

const url = (path: string) => `${ORIGIN}${path}`

function server(mode: ToolMode = 'all', engineOptions: EngineOptions = {}) {
  const { fake, engine } = setup(engineOptions)
  const mcp = new McpHandler({ name: 'test', version: '0.0.0' })
  registerAllTools(mcp, engine, mode)
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    const result = response!.result as { content: { text: string }[]; isError?: true }
    let body: unknown
    try {
      body = JSON.parse(result.content[0]!.text)
    } catch {
      body = result.content[0]!.text
    }
    return { isError: result.isError === true, body: body as Record<string, unknown> }
  }
  return { fake, mcp, call }
}

Deno.test('a stale etag is an isError result with code Conflict', async () => {
  const { call } = server()
  const result = await call('update_todo', {
    url: url(TASKS_ORG_PATH),
    etag: '"stale"',
    summary: 'x',
  })
  assertEquals(result.isError, true)
  assertEquals(result.body['code'], 'Conflict')
})

Deno.test('a malformed due date is an isError result and nothing is written', async () => {
  const { call, fake } = server()
  const result = await call('update_todo', {
    url: url(TASKS_ORG_PATH),
    etag: TASKS_ORG_ETAG,
    due: 'tomorrow',
  })
  assertEquals(result.isError, true)
  assertEquals(fake.requests.filter((r) => r.method === 'PUT'), [])
})

Deno.test('null clears a field through update_todo', async () => {
  const { call } = server()
  const result = await call('update_todo', { url: url(ZONED_PATH), etag: ZONED_ETAG, due: null })
  assertEquals(result.isError, false)
  assertEquals((result.body['todo'] as Record<string, unknown>)['due'], undefined)
})

Deno.test('a date-only due date set through create_todo stays date-only', async () => {
  const { call, fake } = server()
  const created = await call('create_todo', {
    calendarUrl: url('/dav/cal/user%40example.com/tasks/'),
    summary: 'Pay rent',
    due: '2026-11-01',
  })
  assertEquals(created.isError, false)
  const data = fake.objects.get(new URL(created.body['url'] as string).pathname)!.data
  assert(data.includes('\r\nDUE;VALUE=DATE:20261101\r\n'), data)
})

Deno.test('every schema that takes an etag says where it comes from', async () => {
  const { mcp } = server()
  const listed = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tools = (listed!.result as {
    tools: {
      name: string
      inputSchema: { properties?: Record<string, { description?: string }> }
    }[]
  }).tools
  const withEtag = tools.filter((t) => t.inputSchema.properties?.['etag'])
  assertEquals(withEtag.map((t) => t.name).sort(), [
    'delete_event',
    'delete_todo',
    'update_event',
    'update_todo',
  ])
  for (const tool of withEtag) {
    assert(/exactly as (query|get)_/.test(tool.inputSchema.properties!['etag']!.description!))
  }
})

const dataAt = (fake: ReturnType<typeof server>['fake'], path: string) =>
  fake.objects.get(path)!.data
const alarmLines = (data: string): string[] =>
  data.match(/BEGIN:VALARM\r\n[\s\S]*?END:VALARM\r\n/g) ?? []

Deno.test('alarms with before on a task count the reminder from its due date', async () => {
  const { call, fake } = server()
  const before = dataAt(fake, ZONED_PATH)
  const result = await call('update_todo', {
    url: url(ZONED_PATH),
    etag: ZONED_ETAG,
    alarms: [{ before: 'PT1H' }],
  })
  assertEquals(result.isError, false)
  const after = dataAt(fake, ZONED_PATH)
  assertEquals(alarmLines(after), [
    'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RELATED=END:-PT1H\r\n' +
    'DESCRIPTION:Call the bank\r\nEND:VALARM\r\n',
  ])
  assertEquals(
    lineDiff(before, after).removed.filter((l) => !/^(DTSTAMP|LAST-MODIFIED)/.test(l)),
    [],
  )
  assertEquals(
    ((result.body['todo'] as Record<string, unknown>)['reminders'] as unknown[]).length,
    1,
  )
})

Deno.test('alarms with at writes an absolute UTC reminder on an event', async () => {
  const { call, fake } = server()
  const result = await call('update_event', {
    url: url(MEETING_PATH),
    etag: MEETING_ETAG,
    alarms: [{ at: '2026-10-13T08:00:00Z' }],
  })
  assertEquals(result.isError, false)
  const alarms = alarmLines(dataAt(fake, MEETING_PATH))
  assertEquals(alarms.length, 1)
  assert(alarms[0]!.includes('TRIGGER;VALUE=DATE-TIME:20261013T080000Z\r\n'), alarms[0])
})

Deno.test('alarms with before on a new event counts from its start', async () => {
  const { call, fake } = server()
  const created = await call('create_event', {
    calendarUrl: url('/dav/cal/user%40example.com/events/'),
    summary: 'Dentist',
    start: '2026-10-20T09:00:00Z',
    end: '2026-10-20T10:00:00Z',
    alarms: [{ before: 'PT15M' }, { before: 'PT0S' }],
  })
  assertEquals(created.isError, false)
  const data = dataAt(fake, new URL(created.body['url'] as string).pathname)
  assert(data.includes('\r\nTRIGGER:-PT15M\r\n'), data)
  assert(data.includes('\r\nTRIGGER:PT0S\r\n'), data)
})

Deno.test('alarms null removes every reminder and changes nothing else', async () => {
  const { call, fake } = server()
  const before = dataAt(fake, TASKS_ORG_PATH)
  assertEquals(alarmLines(before).length, 1)
  const result = await call('update_todo', {
    url: url(TASKS_ORG_PATH),
    etag: TASKS_ORG_ETAG,
    alarms: null,
  })
  assertEquals(result.isError, false)
  const after = dataAt(fake, TASKS_ORG_PATH)
  assertEquals(alarmLines(after), [])
  const diff = lineDiff(before, after)
  const changed = (lines: string[]) =>
    lines.filter((l) => !/^(DTSTAMP|LAST-MODIFIED|SEQUENCE)/.test(l))
  assertEquals(changed(diff.removed), [
    'BEGIN:VALARM',
    'TRIGGER;RELATED=END;VALUE=DURATION:PT0S',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder text',
    'END:VALARM',
  ])
  assertEquals(changed(diff.added), [])
})

Deno.test('an update without alarms leaves existing reminders byte-identical', async () => {
  const { call, fake } = server()
  const before = alarmLines(dataAt(fake, TASKS_ORG_PATH))
  assertEquals(before.length, 1)
  const result = await call('update_todo', {
    url: url(TASKS_ORG_PATH),
    etag: TASKS_ORG_ETAG,
    summary: 'Water the ferns',
  })
  assertEquals(result.isError, false)
  assertEquals(alarmLines(dataAt(fake, TASKS_ORG_PATH)), before)
})

Deno.test('alarms keeps an equal existing reminder byte for byte', async () => {
  const { call, fake } = server()
  const before = alarmLines(dataAt(fake, MEETING_PATH))
  const result = await call('update_event', {
    url: url(MEETING_PATH),
    etag: MEETING_ETAG,
    alarms: [{ before: 'PT15M' }, { before: 'PT1H' }],
  })
  assertEquals(result.isError, false)
  const after = alarmLines(dataAt(fake, MEETING_PATH))
  assertEquals(after.length, 2)
  assertEquals(after.includes(before[0]!), true)
})

Deno.test('a reminder before due without a due date is refused, nothing written', async () => {
  const { call, fake } = server()
  const result = await call('create_todo', {
    calendarUrl: url('/dav/cal/user%40example.com/tasks/'),
    summary: 'Someday',
    alarms: [{ before: 'PT1H' }],
  })
  assertEquals(result.isError, true)
  assertEquals(result.body['code'], 'Refused')
  assert(String(result.body['error']).includes('DUE'), String(result.body['error']))
  assertEquals(fake.requests.filter((r) => r.method === 'PUT'), [])
})

Deno.test('malformed alarms are an isError result and nothing is written', async () => {
  const { call, fake } = server()
  const bad: unknown[] = [
    'PT1H',
    [{}],
    [{ before: 'PT1H', at: '2026-10-13T08:00:00Z' }],
    [{ before: '1 hour' }],
    [{ before: 'PT1H', after: 'PT1H' }],
    [{ at: '2026-10-13T08:00:00' }],
    [{ at: '2026-10-13' }],
  ]
  for (const alarms of bad) {
    const result = await call('update_todo', {
      url: url(ZONED_PATH),
      etag: ZONED_ETAG,
      alarms,
    })
    assertEquals(result.isError, true, JSON.stringify(alarms))
    const message = typeof result.body === 'string' ? result.body : result.body['error']
    assert(String(message).includes('alarms'), JSON.stringify(alarms))
  }
  assertEquals(fake.requests.filter((r) => r.method === 'PUT'), [])
})

Deno.test('the schemas of the four write tools describe alarms', async () => {
  const { mcp } = server()
  const listed = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tools = (listed!.result as {
    tools: {
      name: string
      inputSchema: { properties?: Record<string, { description?: string; type?: unknown }> }
    }[]
  }).tools
  const names = tools.filter((t) => t.inputSchema.properties?.['alarms']).map((t) => t.name).sort()
  assertEquals(names, ['create_event', 'create_todo', 'update_event', 'update_todo'])
  for (const tool of tools.filter((t) => names.includes(t.name))) {
    const alarms = tool.inputSchema.properties!['alarms']!
    assert(alarms.description!.includes('replaces every existing reminder'))
    assertEquals(
      Array.isArray(alarms.type) && alarms.type.includes('null'),
      tool.name.startsWith('update_'),
    )
  }
})

async function listedNames(mcp: McpHandler): Promise<string[]> {
  const listed = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  return (listed!.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort()
}

const DELETE_TOOLS = ['delete_calendar', 'delete_event', 'delete_todo']
const READ_TOOLS = [
  'get_event',
  'get_todo',
  'list_calendars',
  'list_lists',
  'query_events',
  'query_todos',
]

Deno.test('all lists the delete tools', async () => {
  const names = await listedNames(server('all').mcp)
  for (const name of DELETE_TOOLS) assert(names.includes(name), name)
})

Deno.test('no-delete leaves the three delete tools out of tools/list and keeps the rest', async () => {
  const all = await listedNames(server('all').mcp)
  const names = await listedNames(server('no-delete').mcp)
  assertEquals(names, all.filter((name) => !DELETE_TOOLS.includes(name)))
})

Deno.test('no-delete refuses a delete_todo call and sends no DELETE', async () => {
  const { mcp, fake } = server('no-delete')
  const response = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'delete_todo', arguments: { url: url(TASKS_ORG_PATH), etag: TASKS_ORG_ETAG } },
  })
  assertEquals(response!.error?.message, 'Unknown tool: delete_todo')
  assertEquals(fake.requests.filter((r) => r.method === 'DELETE'), [])
})

Deno.test('read-only lists only the five tools that change nothing', async () => {
  assertEquals(await listedNames(server('read-only').mcp), READ_TOOLS)
})

Deno.test('a task and an event created without a uid get a UUID version 7', async () => {
  const { call, fake } = server('all', { uid: undefined })
  const todo = await call('create_todo', { calendarUrl: url(TASKS), summary: 'Buy milk' })
  const event = await call('create_event', {
    calendarUrl: url(EVENTS),
    summary: 'Dentist',
    start: '2026-10-20T09:00:00Z',
    end: '2026-10-20T10:00:00Z',
  })
  for (const created of [todo, event]) {
    assertEquals(created.isError, false)
    const uid = created.body['uid'] as string
    assertMatch(uid, UUID_V7_PATTERN)
    const data = fake.objects.get(new URL(created.body['url'] as string).pathname)!.data
    assert(data.includes(`\r\nUID:${uid}\r\n`))
  }
  assert(todo.body['uid'] !== event.body['uid'])
})

Deno.test('a task and an event with a version 4 UID are read, updated and deleted under that UID', async () => {
  const { call, fake } = server()
  const entries = [
    {
      kind: 'todo',
      uid: '3f2b8c1e-9d4a-4e6b-a1c7-5d2e8f0b9a34',
      path: `${TASKS}3f2b8c1e-9d4a-4e6b-a1c7-5d2e8f0b9a34.ics`,
      data: ZONED.replace('UID:zoned-task-uid', 'UID:3f2b8c1e-9d4a-4e6b-a1c7-5d2e8f0b9a34'),
    },
    {
      kind: 'event',
      uid: '0b6d1f7a-2c3e-4a58-9b1d-7e4c2a6f8d90',
      path: `${EVENTS}0b6d1f7a-2c3e-4a58-9b1d-7e4c2a6f8d90.ics`,
      data: MEETING.replace('UID:team-sync', 'UID:0b6d1f7a-2c3e-4a58-9b1d-7e4c2a6f8d90'),
    },
  ]
  for (const { kind, uid, path, data } of entries) {
    assert(data.includes(`\r\nUID:${uid}\r\n`), 'the fixture carries the version 4 UID')
    fake.objects.set(path, { etag: '"v4-1"', data })

    const read = await call(`get_${kind}`, { url: url(path) })
    assertEquals(read.isError, false)
    assertEquals(read.body['uid'], uid)

    const updated = await call(`update_${kind}`, {
      url: url(path),
      etag: read.body['etag'],
      summary: 'Renamed',
    })
    assertEquals(updated.isError, false)
    const after = fake.objects.get(path)!
    assert(after.data.includes('\r\nSUMMARY:Renamed\r\n'))
    assert(after.data.includes(`\r\nUID:${uid}\r\n`), 'the update keeps the version 4 UID')

    const deleted = await call(`delete_${kind}`, { url: url(path), etag: after.etag })
    assertEquals(deleted.isError, false)
    assert(!fake.objects.has(path))
  }
})
