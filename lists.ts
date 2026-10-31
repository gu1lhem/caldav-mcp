// ── `caldav-mcp lists`: named groups of calendars ──
// A list is a name and a set of calendar URLs, kept as JSON in CALDAV_LISTS_PATH. The server
// reads that file to answer query_events and query_todos with a list name, and this command
// shows, creates and edits the lists with a numbered picker over the calendars the account holds.

import type { CalendarLists, EngineResult } from './caldav/types.ts'
import type { QueryEngine } from './caldav/query.ts'

/** Where the lists live when CALDAV_LISTS_PATH is unset: a file on the /data volume. */
export const DEFAULT_LISTS_PATH = '/data/lists.json'

/** How to call the command; printed on a wrong call. */
export const LISTS_USAGE = 'Usage: caldav-mcp lists list | add <name> | edit <name> | remove <name>'

/** Where the command writes: out for results, err for errors and usage. */
export interface ListsOutput {
  out(line: string): void
  err(line: string): void
}

/** The seams runLists works through, so the tests can drive it without a server or a terminal. */
export interface ListsDeps {
  readLists(): Promise<CalendarLists>
  writeLists(lists: CalendarLists): Promise<void>
  /** The account's calendars, as list_calendars shows them. Throws on a server failure. */
  listCalendars(): Promise<{ url: string; displayName?: string }[]>
  output: ListsOutput
  /** One line of the owner's input; null when stdin ends. */
  readLine(): Promise<string | null>
}

/** A calendar as the picker shows it. */
interface Entry {
  url: string
  label: string
  selected: boolean
}

function okLists(lists: CalendarLists): EngineResult<CalendarLists> {
  return { success: true, output: lists, error: null }
}

function failLists(message: string): EngineResult<CalendarLists> {
  return { success: false, output: null, error: { code: 'Unreadable', message } }
}

/** A list name the owner may type: trimmed, and never empty. */
export function normalizeListName(raw: string): string {
  const name = raw.trim()
  if (name === '') throw new Error('a list name cannot be empty or only spaces')
  return name
}

/** The lists of a lists file, refusing anything the server could not use. */
export function parseLists(json: string): CalendarLists {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('the lists file is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the lists file must hold a JSON object: { "name": ["calendarUrl", ...] }')
  }
  const lists: CalendarLists = {}
  for (const [rawName, rawUrls] of Object.entries(parsed)) {
    const name = normalizeListName(rawName)
    if (!Array.isArray(rawUrls) || !rawUrls.every((u) => typeof u === 'string' && u !== '')) {
      throw new Error(`list ${name} must hold an array of calendar URLs`)
    }
    if (name in lists) throw new Error(`two lists share the name ${name}`)
    lists[name] = rawUrls
      .map((u) => (u as string).trim())
      .filter((u, index, all) => u !== '' && all.indexOf(u) === index)
  }
  return lists
}

/** The lists of the file at path: an empty set when it does not exist yet, an error when unreadable. */
export async function readListsFile(path: string): Promise<EngineResult<CalendarLists>> {
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return okLists({})
    const reason = err instanceof Error ? err.message : String(err)
    return failLists(`cannot read the lists file at ${path} (CALDAV_LISTS_PATH): ${reason}`)
  }
  try {
    return okLists(parseLists(text))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return failLists(`${path}: ${reason}`)
  }
}

/** The directory of a path, as mkdir needs it: "/data/lists.json" → "/data". */
function parentDir(path: string): string {
  const dir = path.replace(/[^/]*$/, '')
  return dir === '' ? '.' : dir.slice(0, -1) || '/'
}

/** Write the lists as sorted, indented JSON, whole: a half-written file is never left behind. */
export async function writeListsFile(path: string, lists: CalendarLists): Promise<void> {
  const sorted = Object.fromEntries(Object.keys(lists).sort().map((name) => [name, lists[name]!]))
  const tmp = `${path}.tmp`
  await Deno.mkdir(parentDir(path), { recursive: true })
  await Deno.writeTextFile(tmp, JSON.stringify(sorted, null, 2) + '\n')
  await Deno.rename(tmp, path)
}

/** Run one `lists` command through deps. Returns the process exit code. */
export async function runLists(args: readonly string[], deps: ListsDeps): Promise<number> {
  const [command, name] = args
  if (args.length === 1 && command === 'list') return await showLists(deps)
  if (
    args.length === 2 && (command === 'add' || command === 'edit' || command === 'remove') && name
  ) {
    let listName: string
    try {
      listName = normalizeListName(name)
    } catch (err) {
      deps.output.err(err instanceof Error ? err.message : String(err))
      return 1
    }
    if (command === 'remove') return await removeList(listName, deps)
    return await editList(listName, command === 'add', deps)
  }
  deps.output.err(LISTS_USAGE)
  return 2
}

async function showLists(deps: ListsDeps): Promise<number> {
  const lists = await deps.readLists()
  const names = Object.keys(lists).sort()
  if (names.length === 0) {
    deps.output.out('No lists yet. Run "caldav-mcp lists add <name>" to make one.')
    return 0
  }
  let calendars: { url: string; displayName?: string }[] = []
  try {
    calendars = await deps.listCalendars()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.output.out(`(The calendars could not be read; URLs only. ${reason})`)
  }
  const label = (url: string) => calendars.find((c) => c.url === url)?.displayName ?? url
  for (const name of names) {
    deps.output.out(`${name}:`)
    for (const url of lists[name]!) {
      deps.output.out(`  ${label(url)}  ${url}`)
    }
  }
  return 0
}

async function removeList(name: string, deps: ListsDeps): Promise<number> {
  const lists = await deps.readLists()
  if (!(name in lists)) {
    deps.output.err(`No list ${name}.`)
    return 1
  }
  delete lists[name]
  await deps.writeLists(lists)
  deps.output.out(`Removed list ${name}.`)
  return 0
}

/** Create (or edit) one list with the picker; writes only when the owner saves. */
async function editList(name: string, create: boolean, deps: ListsDeps): Promise<number> {
  const lists = await deps.readLists()
  if (create && name in lists) {
    deps.output.err(`List ${name} exists; run "caldav-mcp lists edit ${name}" to change it.`)
    return 1
  }
  if (!create && !(name in lists)) {
    deps.output.err(`No list ${name}. Run "caldav-mcp lists add ${name}" to make it.`)
    return 1
  }
  const picked = await pickCalendars(name, lists[name] ?? [], deps)
  if (picked === null) {
    deps.output.out('Cancelled; nothing written.')
    return 1
  }
  lists[name] = picked
  await deps.writeLists(lists)
  deps.output.out(
    `Saved list ${name} with ${picked.length} ${picked.length === 1 ? 'calendar' : 'calendars'}.`,
  )
  return 0
}

/** The numbered picker: numbers toggle, all and none flip every entry, an empty line saves. */
async function pickCalendars(
  name: string,
  selectedUrls: readonly string[],
  deps: ListsDeps,
): Promise<string[] | null> {
  let calendars: { url: string; displayName?: string }[]
  try {
    calendars = await deps.listCalendars()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.output.err(`The calendars could not be read: ${reason}`)
    return null
  }
  const entries: Entry[] = calendars.map((c) => ({
    url: c.url,
    label: c.displayName ?? c.url,
    selected: selectedUrls.includes(c.url),
  }))
  if (entries.length === 0) {
    deps.output.err('The account holds no calendars.')
    return null
  }
  deps.output.out(`Choose the calendars of "${name}".`)
  while (true) {
    entries.forEach((entry, i) => {
      deps.output.out(`  ${i + 1}. ${entry.selected ? '[x]' : '[ ]'} ${entry.label}  ${entry.url}`)
    })
    deps.output.out(
      'Numbers toggle (like "1 3"), all and none flip every line, Enter saves, q cancels.',
    )
    const line = await deps.readLine()
    if (line === null) return null
    const input = line.trim()
    if (input === 'q') return null
    if (input === '') return entries.filter((e) => e.selected).map((e) => e.url)
    if (input === 'all' || input === 'none') {
      const to = input === 'all'
      entries.forEach((e) => (e.selected = to))
      continue
    }
    let understood = true
    for (const token of input.split(/[\s,]+/).filter((t) => t !== '')) {
      const n = /^\d+$/.test(token) ? Number(token) : NaN
      if (!(n >= 1 && n <= entries.length)) {
        deps.output.err(`"${token}" is not one of the numbers above.`)
        understood = false
        break
      }
      entries[n - 1]!.selected = !entries[n - 1]!.selected
    }
    if (!understood) continue
  }
}

/** Open the engine's calendar list, wire the file at listsPath and stdin, and run the command. */
export async function runListsCommand(
  args: readonly string[],
  listsPath: string,
  engine: Pick<QueryEngine, 'listCalendars'>,
  output: ListsOutput = { out: console.log, err: console.error },
): Promise<number> {
  const deps: ListsDeps = {
    readLists: async () => {
      const read = await readListsFile(listsPath)
      if (!read.success) throw new Error(read.error.message)
      return read.output
    },
    writeLists: (lists) => writeListsFile(listsPath, lists),
    listCalendars: async () => {
      const listed = await engine.listCalendars()
      if (!listed.success) throw new Error(listed.error.message)
      return listed.output
    },
    output,
    readLine: stdinLines(),
  }
  try {
    return await runLists(args, deps)
  } catch (err) {
    output.err(err instanceof Error ? err.message : String(err))
    return 1
  }
}

/** One line of stdin per call; null when it ends. */
export function stdinLines(): () => Promise<string | null> {
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  return async () => {
    if (ended) return null
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        return line
      }
      const chunk = new Uint8Array(4096)
      const n = await Deno.stdin.read(chunk)
      if (n === null) {
        ended = true
        const rest = buffer
        buffer = ''
        return rest === '' ? null : rest
      }
      buffer += decoder.decode(chunk.subarray(0, n), { stream: true })
    }
  }
}
