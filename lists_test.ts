// ── Calendar lists: the file and the CLI ──

import { assert, assertEquals, assertThrows } from 'std/assert/mod.ts'
import {
  LISTS_USAGE,
  type ListsDeps,
  normalizeListName,
  parseLists,
  readListsFile,
  runLists,
  writeListsFile,
} from './lists.ts'
import type { CalendarLists } from './caldav/types.ts'

// ── names and the file format ──

Deno.test('a list name is trimmed and never blank', () => {
  assertEquals(normalizeListName('  perso  '), 'perso')
  for (const blank of ['', '   ', '\t']) assertThrows(() => normalizeListName(blank))
})

Deno.test('parseLists reads a lists file and tidies it', () => {
  assertEquals(
    parseLists('{"perso":["https://dav/a/","https://dav/a/"," https://dav/b/ "]}'),
    { perso: ['https://dav/a/', 'https://dav/b/'] },
  )
  assertEquals(parseLists('{}'), {})
  assertEquals(parseLists('{"empty":[]}'), { empty: [] })
})

Deno.test('parseLists refuses everything the server could not use', () => {
  for (
    const bad of [
      'nope',
      '[]',
      '"x"',
      '{"a":"b"}',
      '{"a":[1]}',
      '{"a":[""]}',
      '{"a":[]," a":[]}',
    ]
  ) {
    assertThrows(() => parseLists(bad), Error, undefined, bad)
  }
})

Deno.test('the lists file round-trips and a missing file reads as empty', async () => {
  const dir = await Deno.makeTempDir()
  const path = `${dir}/lists.json`
  assertEquals(await readListsFile(path), { success: true, output: {}, error: null })
  await writeListsFile(path, { perso: ['https://dav/a/'], zz: [] })
  assertEquals(await readListsFile(path), {
    success: true,
    output: { perso: ['https://dav/a/'], zz: [] },
    error: null,
  })
  // The keys are sorted, so the file only changes when a list really changed.
  assertEquals(
    await Deno.readTextFile(path),
    '{\n  "perso": [\n    "https://dav/a/"\n  ],\n  "zz": []\n}\n',
  )
  await Deno.remove(dir, { recursive: true })
})

Deno.test('a lists file that is not a lists file is an Unreadable error', async () => {
  const dir = await Deno.makeTempDir()
  const path = `${dir}/lists.json`
  await Deno.writeTextFile(path, 'not json')
  const result = await readListsFile(path)
  assertEquals(result.success, false)
  if (result.success) return
  assertEquals(result.error.code, 'Unreadable')
  assert(result.error.message.includes(path))
  await Deno.remove(dir, { recursive: true })
})

// ── the CLI ──

/** The command under test, with the lists, the input lines and the output recorded. */
function harness(lists: CalendarLists, lines: string[]) {
  const out: string[] = []
  const err: string[] = []
  const written: CalendarLists[] = []
  let state: CalendarLists = lists
  const deps: ListsDeps = {
    readLists: () => Promise.resolve(state),
    writeLists: (l) => {
      written.push(l)
      state = l
      return Promise.resolve()
    },
    listCalendars: () =>
      Promise.resolve([
        { url: 'https://dav/a/', displayName: 'Alpha' },
        { url: 'https://dav/b/', displayName: 'Beta' },
      ]),
    output: { out: (line) => out.push(line), err: (line) => err.push(line) },
    readLine: () => Promise.resolve(lines.shift() ?? null),
  }
  return { deps, out, err, written }
}

Deno.test('a wrong call prints the usage', async () => {
  const h = harness({}, [])
  assertEquals(await runLists([], h.deps), 2)
  assertEquals(h.err, [LISTS_USAGE])
})

Deno.test('list names the lists and their calendars', async () => {
  const h = harness({ perso: ['https://dav/a/'] }, [])
  assertEquals(await runLists(['list'], h.deps), 0)
  const text = h.out.join('\n')
  assert(text.includes('perso'), text)
  assert(text.includes('Alpha'), text)
})

Deno.test('list without lists says so', async () => {
  const h = harness({}, [])
  assertEquals(await runLists(['list'], h.deps), 0)
  assert(h.out.join('\n').includes('No lists yet'), h.out.join('\n'))
})

Deno.test('add saves the picked calendars and keeps the others', async () => {
  const h = harness({ other: ['https://dav/b/'] }, ['1', ''])
  assertEquals(await runLists(['add', 'perso'], h.deps), 0)
  assertEquals(h.written, [{ other: ['https://dav/b/'], perso: ['https://dav/a/'] }])
})

Deno.test('add refuses an existing list, edit refuses a new one', async () => {
  const existing = harness({ perso: [] }, ['all', ''])
  assertEquals(await runLists(['add', 'perso'], existing.deps), 1)
  assertEquals(existing.written, [])
  const missing = harness({}, ['all', ''])
  assertEquals(await runLists(['edit', 'perso'], missing.deps), 1)
  assertEquals(missing.written, [])
})

Deno.test('edit starts from the current members', async () => {
  const h = harness({ perso: ['https://dav/b/'] }, ['1', ''])
  assertEquals(await runLists(['edit', 'perso'], h.deps), 0)
  assertEquals(h.written, [{ perso: ['https://dav/a/', 'https://dav/b/'] }])
})

Deno.test('all and none flip every calendar', async () => {
  const h = harness({}, ['none', 'all', ''])
  assertEquals(await runLists(['add', 'perso'], h.deps), 0)
  assertEquals(h.written, [{ perso: ['https://dav/a/', 'https://dav/b/'] }])
})

Deno.test('the built-in list all cannot be made, edited or removed', async () => {
  for (const command of ['add', 'edit', 'remove'] as const) {
    const h = harness({}, [''])
    assertEquals(await runLists([command, 'all'], h.deps), 1)
    assertEquals(h.written, [])
    assert(h.err.join('\n').includes('built in'), h.err.join('\n'))
  }
})

Deno.test('a number out of range is refused and nothing is saved yet', async () => {
  const h = harness({}, ['9', '1', ''])
  assertEquals(await runLists(['add', 'perso'], h.deps), 0)
  assert(h.err.some((line) => line.includes('"9"')), h.err.join('\n'))
  assertEquals(h.written, [{ perso: ['https://dav/a/'] }])
})

Deno.test('q and the end of the input cancel; nothing is written', async () => {
  for (const lines of [['q'], []]) {
    const h = harness({}, lines)
    assertEquals(await runLists(['add', 'perso'], h.deps), 1)
    assertEquals(h.written, [])
    assert(h.out.join('\n').includes('Cancelled'), h.out.join('\n'))
  }
})

Deno.test('remove deletes one list and keeps the others', async () => {
  const h = harness({ perso: [], other: [] }, [])
  assertEquals(await runLists(['remove', 'perso'], h.deps), 0)
  assertEquals(h.written, [{ other: [] }])
})

Deno.test('remove of a missing list fails', async () => {
  const h = harness({}, [])
  assertEquals(await runLists(['remove', 'perso'], h.deps), 1)
  assertEquals(h.written, [])
})

Deno.test('a list name of spaces is refused', async () => {
  const h = harness({}, [''])
  assertEquals(await runLists(['add', '  '], h.deps), 1)
  assert(h.err.join('\n').includes('cannot be empty'), h.err.join('\n'))
})
