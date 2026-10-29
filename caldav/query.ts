// ── Calendar engine ──
// Tasks and events over `@spy4x/caldav` (protocol) and `@spy4x/time/ical-tasks` (lossless
// iCalendar edits). Edits re-read the object, patch only the changed properties and write it back
// with the caller's etag, so a change made elsewhere is never overwritten.

import {
  type CalDavCalendar,
  type CalDavClient,
  type CalDavError,
  CalDavErrorCode,
  type CalDavObject,
  type CalDavResult,
} from '@spy4x/caldav'
import { sameResource } from '@spy4x/caldav/url'
import { uuidV7 } from '@spy4x/platform/universal/uuid'
import {
  getProperty,
  type IcalComponent,
  type IcalResult,
  parseIcal,
  serializeIcal,
  setProperty,
} from '@spy4x/time/ical'
import {
  type Alarm,
  AlarmRelated,
  AlarmTriggerKind,
  type CalendarEvent,
  completeTodo,
  CompleteTodoKind,
  type EventPatch,
  EventStatus,
  newEvent,
  newTodo,
  patchEvent,
  patchTodo,
  readEvent,
  readTodo,
  reopenTodo,
  type Todo,
  type TodoPatch,
  TodoStatus,
} from '@spy4x/time/ical-tasks'
import { dueInstant, formatIcalDate, startInstant } from './dates.ts'
import type {
  CalendarInfo,
  CalendarLists,
  EngineError,
  EngineResult,
  EventDetail,
  EventQueryResult,
  EventSummary,
  ListInfo,
  TodoDetail,
  TodoQueryResult,
  TodoSummary,
  WriteResult,
} from './types.ts'

export const PRODID = '-//spy4x//caldav-mcp//EN'
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export const TODO_STATUS_NAMES: Record<TodoStatus, string> = {
  [TodoStatus.NeedsAction]: 'NEEDS-ACTION',
  [TodoStatus.InProcess]: 'IN-PROCESS',
  [TodoStatus.Completed]: 'COMPLETED',
  [TodoStatus.Cancelled]: 'CANCELLED',
}

export const EVENT_STATUS_NAMES: Record<EventStatus, string> = {
  [EventStatus.Tentative]: 'TENTATIVE',
  [EventStatus.Confirmed]: 'CONFIRMED',
  [EventStatus.Cancelled]: 'CANCELLED',
}

const CONFLICT_HINT =
  'It changed since it was read: read it again (get_todo / get_event), re-apply the change and ' +
  'retry with the new etag.'

/** Inputs the engine would otherwise take from the machine, injectable for tests. */
export interface EngineOptions {
  /** The clock for DTSTAMP, LAST-MODIFIED, COMPLETED and "overdue". Default: `new Date()`. */
  now?: () => Date
  /** IANA zone that date-only and floating values are read in. Default: the host's zone. */
  zone?: string
  /** UID generator for new tasks and events. Default: a UUID version 7. */
  uid?: () => string
  /**
   * The named calendar lists, read fresh on every call, so the CLI's edits apply without a
   * restart. Default: none; every `list` filter is then refused with NoLists.
   */
  lists?: () => Promise<EngineResult<CalendarLists>>
}

/** Filters of {@link QueryEngine.queryTodos}. */
export interface TodoQuery {
  calendarUrl?: string
  /** The calendars of this named list; exclusive with `calendarUrl`. */
  list?: string
  status?: TodoStatus
  /** Case-insensitive, in summary and description. */
  text?: string
  /** Only tasks due before this instant. */
  dueBefore?: Date
  priority?: { min?: number; max?: number }
  /** Also list completed tasks. Implied by `status: Completed`. */
  includeCompleted?: boolean
  /** Full task details instead of the compact list. */
  detail?: boolean
  limit?: number
}

/** Filters of {@link QueryEngine.queryEvents}. */
export interface EventQuery {
  calendarUrl?: string
  /** The calendars of this named list; exclusive with `calendarUrl`. */
  list?: string
  from?: Date
  to?: Date
  text?: string
  limit?: number
}

/** A change to a task: the library patch plus the fields this server handles itself. */
export interface TodoChange extends Omit<TodoPatch, 'status' | 'relatedTo' | 'completed'> {
  /** `Completed` completes like Tasks.org (a repeating task moves to its next date). */
  status?: TodoStatus | null
  /** UID of the parent task; `null` removes the parent link. Other links are kept. */
  parent?: string | null
}

/** What {@link QueryEngine.updateTodo} reports. */
export interface TodoUpdate extends WriteResult {
  /** `advanced`: a repeating task moved to its next date and is still open. */
  completion?: 'completed' | 'advanced'
  todo: TodoDetail
}

function ok<T>(output: T): EngineResult<T> {
  return { success: true, output, error: null }
}

function fail<T>(code: string, message: string): EngineResult<T> {
  return { success: false, output: null, error: { code, message } }
}

function fromCalDav(error: CalDavError): EngineError {
  const code = CalDavErrorCode[error.code] ?? 'Server'
  if (error.code === CalDavErrorCode.Conflict) {
    return { code, message: `${error.message}. ${CONFLICT_HINT}` }
  }
  return { code, message: error.message }
}

function caldavFail<T>(result: CalDavResult<unknown>): EngineResult<T> {
  return { success: false, output: null, error: fromCalDav(result.error!) }
}

function icalFail<T>(result: IcalResult<unknown>): EngineResult<T> {
  return fail('Refused', result.error?.message ?? 'the edit was refused')
}

/** The calendar an object URL belongs to: its URL without the last segment. */
function parentOf(url: string): string {
  return new URL('.', url).href
}

function triggerText(alarm: Alarm): string | undefined {
  const trigger = alarm.trigger
  if (!trigger) return undefined
  if (trigger.kind === AlarmTriggerKind.Absolute) return formatIcalDate(trigger.at)
  return trigger.related === AlarmRelated.End ? `${trigger.duration} from end` : trigger.duration
}

function reminders(alarms: Alarm[]): { action?: string; trigger?: string }[] {
  return alarms.map((alarm) => {
    const out: { action?: string; trigger?: string } = {}
    if (alarm.action) out.action = alarm.action
    const trigger = triggerText(alarm)
    if (trigger) out.trigger = trigger
    return out
  })
}

/** Drop absent fields so the JSON the model reads stays short. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}

function parentUid(todo: Todo): string | undefined {
  return todo.relatedTo.find((link) => link.type === 'PARENT')?.uid
}

function todoDetail(todo: Todo, url: string, etag: string | null): TodoDetail {
  return compact({
    url,
    etag,
    calendarUrl: parentOf(url),
    uid: todo.uid,
    summary: todo.summary,
    description: todo.description,
    status: todo.status ? TODO_STATUS_NAMES[todo.status] : undefined,
    priority: todo.priority,
    start: todo.start && formatIcalDate(todo.start),
    due: todo.due && formatIcalDate(todo.due),
    completed: todo.completed && formatIcalDate(todo.completed),
    percentComplete: todo.percentComplete,
    categories: todo.categories,
    parent: parentUid(todo),
    relatedTo: todo.relatedTo,
    rrule: todo.rrule,
    sortOrder: todo.sortOrder,
    reminders: reminders(todo.alarms),
  })
}

function eventDetail(event: CalendarEvent, url: string, etag: string | null): EventDetail {
  return compact({
    url,
    etag,
    calendarUrl: parentOf(url),
    uid: event.uid,
    summary: event.summary,
    description: event.description,
    location: event.location,
    status: event.status ? EVENT_STATUS_NAMES[event.status] : undefined,
    start: event.start && formatIcalDate(event.start),
    end: event.end && formatIcalDate(event.end),
    duration: event.duration,
    categories: event.categories,
    rrule: event.rrule,
    repeats: event.repeats ? true as const : undefined,
    reminders: reminders(event.alarms),
  })
}

/**
 * Each library call (reopen, patch, complete) raises SEQUENCE by one, but one tool call is one
 * change: cap the task's SEQUENCE at one above where it started.
 */
function oneSequenceStep(root: IcalComponent, before: number | undefined): void {
  const once = (before !== undefined && before > 0 ? before : 0) + 1
  const master = root.components.find((c) =>
    c.name === 'VTODO' && getProperty(c, 'RECURRENCE-ID') === undefined
  )
  const now = master && Number(getProperty(master, 'SEQUENCE')?.value)
  if (master && now !== undefined && now > once) setProperty(master, 'SEQUENCE', String(once))
}

function isOpen(todo: Todo): boolean {
  return todo.status !== TodoStatus.Completed && todo.status !== TodoStatus.Cancelled &&
    todo.completed === undefined
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Calendars and the objects read from them, with the calendars that failed. */
interface Gathered<T> {
  items: { item: T; object: CalDavObject; calendar: CalDavCalendar }[]
  unreadable: number
  failed: { url: string; code: string; message: string }[]
}

/**
 * Tasks, events and calendars of one CalDAV account. Every method returns
 * `{ success, output, error }` and never throws for a server failure.
 */
export class QueryEngine {
  readonly #client: CalDavClient
  readonly #now: () => Date
  readonly #zone: string
  readonly #uid: () => string
  readonly #lists: (() => Promise<EngineResult<CalendarLists>>) | undefined
  #homes?: string[]
  /** The last calendar list, for checking object URLs without a PROPFIND each time. */
  #calendarCache?: CalDavCalendar[]

  constructor(client: CalDavClient, options: EngineOptions = {}) {
    this.#client = client
    this.#now = options.now ?? (() => new Date())
    this.#zone = options.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    this.#uid = options.uid ?? uuidV7
    this.#lists = options.lists
  }

  /** The IANA zone that date-only and floating values are read in. */
  get zone(): string {
    return this.#zone
  }

  /** The user's calendar homes, discovered once. */
  async #homeUrls(): Promise<EngineResult<string[]>> {
    if (this.#homes) return ok(this.#homes)
    const found = await this.#client.discover()
    if (!found.success) return caldavFail(found)
    this.#homes = found.output.homeUrls
    return ok(this.#homes)
  }

  async #calendars(): Promise<EngineResult<CalDavCalendar[]>> {
    const homes = await this.#homeUrls()
    if (!homes.success) return homes
    const all: CalDavCalendar[] = []
    for (const home of homes.output) {
      const listed = await this.#client.listCalendars(home)
      if (!listed.success) return caldavFail(listed)
      all.push(...listed.output)
    }
    this.#calendarCache = all
    return ok(all)
  }

  /**
   * Refuse an object URL that is not directly inside a listed calendar, so a task or event tool
   * never reads, writes or deletes a calendar, a principal or another user's data. The cached list
   * is tried first and refreshed once when the calendar is not in it.
   */
  async #knownObject(url: string): Promise<EngineResult<null>> {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return fail('InvalidArgument', `url is not a URL: ${url}`)
    }
    if (target.pathname.endsWith('/')) {
      return fail('InvalidArgument', `${url} is a collection, not a task or event`)
    }
    if (/[?#]/.test(url)) {
      return fail('InvalidArgument', `${url} has a query or fragment; pass the url as listed`)
    }
    // An encoded separator could step out of the calendar on the server. Dot segments need no
    // check: `new URL` resolves `.`, `..` and their `%2e` spellings before this runs.
    let name: string
    try {
      name = decodeURIComponent(target.pathname.slice(target.pathname.lastIndexOf('/') + 1))
    } catch {
      return fail('InvalidArgument', `${url} has a malformed escape`)
    }
    if (/[/\\]/.test(name)) {
      return fail('InvalidArgument', `${url} does not name one item inside a calendar`)
    }
    const parent = new URL('.', target)
    const inList = (list: CalDavCalendar[]) => list.some((c) => sameResource(c.url, parent))
    if (this.#calendarCache && inList(this.#calendarCache)) return ok(null)
    const calendars = await this.#calendars()
    if (!calendars.success) return calendars
    if (inList(calendars.output)) return ok(null)
    return fail(
      'UnknownCalendar',
      `${url} is not inside one of the calendars list_calendars returns`,
    )
  }

  /** Every calendar of the account. */
  async listCalendars(): Promise<EngineResult<CalendarInfo[]>> {
    const calendars = await this.#calendars()
    if (!calendars.success) return calendars
    return ok(calendars.output.map((c) =>
      compact({
        url: c.url,
        displayName: c.displayName,
        components: c.components,
        color: c.color,
        ctag: c.ctag,
      })
    ))
  }

  /**
   * The named lists and their members, as the `list_lists` tool shows them: a null displayName
   * marks a calendar that no longer exists, so a stale list is visible before it is queried.
   */
  async listLists(): Promise<EngineResult<ListInfo[]>> {
    if (!this.#lists) return ok([])
    const lists = await this.#lists()
    if (!lists.success) return lists
    const calendars = await this.#calendars()
    if (!calendars.success) return calendars
    return ok(Object.entries(lists.output).map(([name, urls]) => ({
      name,
      calendars: urls.map((url) => ({
        url,
        displayName: calendars.output.find((c) => sameResource(c.url, url))?.displayName ?? null,
      })),
    })))
  }

  /** The listed calendar at `url`; anything else is refused, never guessed. */
  async #knownCalendar(url: string, component?: string): Promise<EngineResult<CalDavCalendar>> {
    const calendars = await this.#calendars()
    if (!calendars.success) return calendars
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return fail('InvalidArgument', `calendarUrl is not a URL: ${url}`)
    }
    const found = calendars.output.find((c) => sameResource(c.url, target))
    if (!found) {
      return fail('UnknownCalendar', `${url} is not one of the calendars list_calendars returns`)
    }
    if (component && found.components.length > 0 && !found.components.includes(component)) {
      return fail('InvalidArgument', `${found.displayName} does not hold ${component}`)
    }
    return ok(found)
  }

  async #targets(
    calendarUrl: string | undefined,
    component: string,
    list?: string,
  ): Promise<EngineResult<CalDavCalendar[]>> {
    if (calendarUrl && list) {
      return fail('InvalidArgument', 'calendarUrl and list are exclusive: pass one of the two')
    }
    if (list) return await this.#listTargets(list, component)
    if (calendarUrl) {
      const one = await this.#knownCalendar(calendarUrl, component)
      return one.success ? ok([one.output]) : one
    }
    const calendars = await this.#calendars()
    if (!calendars.success) return calendars
    return ok(
      calendars.output.filter((c) => c.components.length === 0 || c.components.includes(component)),
    )
  }

  /**
   * The calendars of the list `list` that hold `component`. The whole list is refused when one of
   * its calendars no longer exists, so a query never silently answers with half the list.
   */
  async #listTargets(list: string, component: string): Promise<EngineResult<CalDavCalendar[]>> {
    if (!this.#lists) {
      return fail('NoLists', 'this server runs without calendar lists (CALDAV_LISTS_PATH)')
    }
    const lists = await this.#lists()
    if (!lists.success) return lists
    const urls = lists.output[list]
    if (!urls) {
      return fail('UnknownList', `${list} is not a calendar list; list_lists shows the current ones`)
    }
    const calendars = await this.#calendars()
    if (!calendars.success) return calendars
    const missing = urls.filter((url) => !calendars.output.some((c) => sameResource(c.url, url)))
    if (missing.length > 0) {
      return fail(
        'UnknownCalendar',
        `list ${list} names calendars list_calendars no longer returns: ${missing.join(', ')}`,
      )
    }
    const picked = calendars.output.filter((c) => urls.some((url) => sameResource(c.url, url)))
    return ok(picked.filter((c) => c.components.length === 0 || c.components.includes(component)))
  }

  /** Read every object of `component` from the target calendars. */
  async #gather<T>(
    calendars: CalDavCalendar[],
    component: string,
    options: { includeCompleted?: boolean; timeRange?: { start?: Date; end?: Date } },
    read: (root: IcalComponent) => T | undefined,
  ): Promise<Gathered<T>> {
    const out: Gathered<T> = { items: [], unreadable: 0, failed: [] }
    const lists = await Promise.all(
      calendars.map((calendar) =>
        this.#client.listObjects(calendar.url, {
          component,
          includeCompleted: options.includeCompleted,
          timeRange: options.timeRange,
        })
      ),
    )
    calendars.forEach((calendar, index) => {
      const listed = lists[index]!
      if (!listed.success) {
        out.failed.push({ url: calendar.url, ...fromCalDav(listed.error) })
        return
      }
      for (const object of listed.output) {
        const parsed = parseIcal(object.data)
        const item = parsed.success ? read(parsed.output) : undefined
        if (item === undefined) out.unreadable++
        else out.items.push({ item, object, calendar })
      }
    })
    return out
  }

  /** Tasks across all calendars (or one, or one named list), with counts. Compact unless `detail`. */
  async queryTodos(query: TodoQuery): Promise<EngineResult<TodoQueryResult>> {
    const targets = await this.#targets(query.calendarUrl, 'VTODO', query.list)
    if (!targets.success) return targets
    const includeCompleted = query.includeCompleted === true ||
      query.status === TodoStatus.Completed
    const gathered = await this.#gather(targets.output, 'VTODO', { includeCompleted }, readTodo)
    if (gathered.failed.length > 0 && gathered.failed.length === targets.output.length) {
      const first = gathered.failed[0]!
      return fail(first.code, `${first.url}: ${first.message}`)
    }

    const now = this.#now()
    const needle = query.text?.toLowerCase()
    const min = query.priority?.min ?? 1
    const max = query.priority?.max ?? 9
    const matching = gathered.items.filter(({ item }) => {
      if (query.status !== undefined && item.status !== query.status) return false
      if (needle) {
        const haystack = `${item.summary ?? ''}\n${item.description ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      if (query.dueBefore) {
        const due = item.due && startInstant(item.due, this.#zone)
        if (!due || due >= query.dueBefore) return false
      }
      if (query.priority) {
        if (!item.priority || item.priority < min || item.priority > max) return false
      }
      return true
    })

    const byStatus: Record<string, number> = {}
    const byPriority = { high: 0, medium: 0, low: 0, none: 0 }
    let overdue = 0
    for (const { item } of matching) {
      const label = item.status ? TODO_STATUS_NAMES[item.status] : 'NONE'
      byStatus[label] = (byStatus[label] ?? 0) + 1
      if (!item.priority) byPriority.none++
      else if (item.priority <= 3) byPriority.high++
      else if (item.priority <= 6) byPriority.medium++
      else byPriority.low++
      const due = item.due && dueInstant(item.due, this.#zone)
      if (isOpen(item) && due && due < now) overdue++
    }

    const sortKey = (todo: Todo) =>
      (todo.due && startInstant(todo.due, this.#zone)?.getTime()) ??
        Number.POSITIVE_INFINITY
    matching.sort((a, b) => sortKey(a.item) - sortKey(b.item))
    const limit = clampLimit(query.limit)
    const todos = matching.slice(0, limit).map(({ item, object, calendar }) =>
      query.detail ? todoDetail(item, object.url, object.etag) : compact<TodoSummary>({
        url: object.url,
        etag: object.etag,
        summary: item.summary,
        status: item.status ? TODO_STATUS_NAMES[item.status] : undefined,
        due: item.due && formatIcalDate(item.due),
        priority: item.priority || undefined,
        repeats: item.repeats ? true : undefined,
        calendar: calendar.displayName,
      })
    )
    return ok(compact({
      total: matching.length,
      byStatus,
      byPriority,
      overdue,
      truncated: matching.length > todos.length,
      todos,
      unreadable: gathered.unreadable || undefined,
      failedCalendars: gathered.failed.length > 0 ? gathered.failed : undefined,
    }))
  }

  async #read(url: string): Promise<EngineResult<{ object: CalDavObject; root: IcalComponent }>> {
    const known = await this.#knownObject(url)
    if (!known.success) return known
    const got = await this.#client.getObject(url)
    if (!got.success) return caldavFail(got)
    const parsed = parseIcal(got.output.data)
    if (!parsed.success) {
      return fail('Unreadable', `the object is not valid iCalendar: ${parsed.error.message}`)
    }
    return ok({ object: got.output, root: parsed.output })
  }

  /** One task with every field this server reads. */
  async getTodo(url: string): Promise<EngineResult<TodoDetail>> {
    const read = await this.#read(url)
    if (!read.success) return read
    const todo = readTodo(read.output.root)
    if (!todo) return fail('NotATask', `${url} holds no VTODO`)
    return ok(todoDetail(todo, read.output.object.url, read.output.object.etag))
  }

  /** One event. */
  async getEvent(url: string): Promise<EngineResult<EventDetail>> {
    const read = await this.#read(url)
    if (!read.success) return read
    const event = readEvent(read.output.root)
    if (!event) return fail('NotAnEvent', `${url} holds no VEVENT`)
    return ok(eventDetail(event, read.output.object.url, read.output.object.etag))
  }

  /** The etag of a write, re-read when the server did not send one. */
  async #etagAfterWrite(url: string, etag: string | null): Promise<string | null> {
    if (etag !== null) return etag
    const again = await this.#client.getObject(url)
    return again.success ? again.output.etag : null
  }

  /**
   * Re-read `url`, refuse when its etag is not `etag`, apply `edit` to the parsed document and
   * write it back conditionally. The document is discarded when `edit` refuses.
   */
  async #edit<T>(
    url: string,
    etag: string,
    edit: (root: IcalComponent) => EngineResult<T>,
  ): Promise<EngineResult<{ write: WriteResult; root: IcalComponent; result: T }>> {
    if (!etag) return fail('InvalidArgument', 'etag is required: pass the one get_todo returned')
    const read = await this.#read(url)
    if (!read.success) return read
    const { object, root } = read.output
    if (object.etag !== null && object.etag !== etag) {
      return fail('Conflict', `the etag ${etag} is not the current one. ${CONFLICT_HINT}`)
    }
    const edited = edit(root)
    if (!edited.success) return edited
    const written = await this.#client.updateObject(url, serializeIcal(root), etag)
    if (!written.success) return caldavFail(written)
    const newEtag = await this.#etagAfterWrite(written.output.url, written.output.etag)
    return ok({ write: { url: written.output.url, etag: newEtag }, root, result: edited.output })
  }

  /** Turn a {@link TodoChange} into the library patch, given the task as it reads now. */
  #todoPatch(change: TodoChange, current: Todo | undefined): TodoPatch {
    const { status: _status, parent, ...rest } = change
    const patch: TodoPatch = { ...rest }
    if (parent !== undefined) {
      const others = (current?.relatedTo ?? []).filter((link) => link.type !== 'PARENT')
      patch.relatedTo = parent === null ? others : [...others, { uid: parent, type: 'PARENT' }]
    }
    return patch
  }

  /** Create a task in a listed calendar. */
  async createTodo(
    calendarUrl: string,
    change: TodoChange,
    uid?: string,
  ): Promise<EngineResult<WriteResult & { uid: string }>> {
    const calendar = await this.#knownCalendar(calendarUrl, 'VTODO')
    if (!calendar.success) return calendar
    const id = uid ?? this.#uid()
    const fields = this.#todoPatch(change, undefined)
    if (change.status !== undefined) fields.status = change.status
    const made = newTodo(fields, { uid: id, now: this.#now(), prodid: PRODID })
    if (!made.success) return icalFail(made)
    const created = await this.#client.createObject(
      calendar.output.url,
      serializeIcal(made.output),
    )
    if (!created.success) return caldavFail(created)
    const etag = await this.#etagAfterWrite(created.output.url, created.output.etag)
    return ok({ url: created.output.url, etag, uid: id })
  }

  /**
   * Change a task. Only the given fields change; every other line is written back as it was.
   * `status: Completed` completes the task like Tasks.org: a repeating one moves to its next
   * date and stays open. Setting an open status on a completed task reopens it.
   */
  async updateTodo(
    url: string,
    etag: string,
    change: TodoChange,
  ): Promise<EngineResult<TodoUpdate>> {
    const now = this.#now()
    let completion: TodoUpdate['completion']
    const edited = await this.#edit<boolean>(url, etag, (root) => {
      const current = readTodo(root)
      if (!current) return fail('NotATask', `${url} holds no VTODO`)
      const wasCompleted = current.status === TodoStatus.Completed ||
        current.completed !== undefined
      const patch = this.#todoPatch(change, current)
      const status = change.status
      if (status !== undefined && status !== TodoStatus.Completed && wasCompleted) {
        const reopened = reopenTodo(root, { now })
        if (!reopened.success) return fail('Refused', reopened.error.message)
      }
      if (status !== undefined && status !== TodoStatus.Completed) {
        if (!(status === TodoStatus.NeedsAction && wasCompleted)) patch.status = status
      }
      const patched = patchTodo(root, patch, { now })
      if (!patched.success) return icalFail(patched)
      if (status === TodoStatus.Completed && !wasCompleted) {
        const done = completeTodo(root, { now })
        if (!done.success) return fail('Refused', done.error.message)
        completion = done.output.kind === CompleteTodoKind.Advanced ? 'advanced' : 'completed'
      }
      oneSequenceStep(root, current.sequence)
      return ok(true)
    })
    if (!edited.success) return edited
    const todo = readTodo(edited.output.root)!
    return ok(compact({
      ...edited.output.write,
      completion,
      todo: todoDetail(todo, edited.output.write.url, edited.output.write.etag),
    }))
  }

  /** Delete a task or event if it still has `etag`. */
  async deleteObject(url: string, etag: string): Promise<EngineResult<null>> {
    if (!etag) return fail('InvalidArgument', 'etag is required: pass the one get_todo returned')
    const known = await this.#knownObject(url)
    if (!known.success) return known
    const deleted = await this.#client.deleteObject(url, etag)
    return deleted.success ? ok(null) : caldavFail(deleted)
  }

  /** Events across all calendars (or one, or one named list), optionally in a time range. */
  async queryEvents(query: EventQuery): Promise<EngineResult<EventQueryResult>> {
    const targets = await this.#targets(query.calendarUrl, 'VEVENT', query.list)
    if (!targets.success) return targets
    const timeRange = query.from || query.to ? { start: query.from, end: query.to } : undefined
    const gathered = await this.#gather(targets.output, 'VEVENT', { timeRange }, readEvent)
    if (gathered.failed.length > 0 && gathered.failed.length === targets.output.length) {
      const first = gathered.failed[0]!
      return fail(first.code, `${first.url}: ${first.message}`)
    }
    const needle = query.text?.toLowerCase()
    const matching = gathered.items.filter(({ item }) =>
      !needle ||
      `${item.summary ?? ''}\n${item.description ?? ''}\n${item.location ?? ''}`.toLowerCase()
        .includes(needle)
    )
    const now = this.#now()
    const startOf = (event: CalendarEvent) => event.start && startInstant(event.start, this.#zone)
    const upcoming = matching.filter(({ item }) => {
      const start = startOf(item)
      return start !== undefined && start >= now
    }).length
    matching.sort((a, b) =>
      (startOf(a.item)?.getTime() ?? Number.POSITIVE_INFINITY) -
      (startOf(b.item)?.getTime() ?? Number.POSITIVE_INFINITY)
    )
    const limit = clampLimit(query.limit)
    const events = matching.slice(0, limit).map(({ item, object, calendar }) =>
      compact<EventSummary>({
        url: object.url,
        etag: object.etag,
        summary: item.summary,
        start: item.start && formatIcalDate(item.start),
        end: item.end && formatIcalDate(item.end),
        location: item.location,
        status: item.status ? EVENT_STATUS_NAMES[item.status] : undefined,
        repeats: item.repeats ? true : undefined,
        calendar: calendar.displayName,
      })
    )
    return ok(compact({
      total: matching.length,
      upcoming,
      truncated: matching.length > events.length,
      events,
      unreadable: gathered.unreadable || undefined,
      failedCalendars: gathered.failed.length > 0 ? gathered.failed : undefined,
    }))
  }

  /** Create an event in a listed calendar. */
  async createEvent(
    calendarUrl: string,
    fields: EventPatch,
    uid?: string,
  ): Promise<EngineResult<WriteResult & { uid: string }>> {
    const calendar = await this.#knownCalendar(calendarUrl, 'VEVENT')
    if (!calendar.success) return calendar
    const id = uid ?? this.#uid()
    const made = newEvent(fields, { uid: id, now: this.#now(), prodid: PRODID })
    if (!made.success) return icalFail(made)
    const created = await this.#client.createObject(
      calendar.output.url,
      serializeIcal(made.output),
    )
    if (!created.success) return caldavFail(created)
    const etag = await this.#etagAfterWrite(created.output.url, created.output.etag)
    return ok({ url: created.output.url, etag, uid: id })
  }

  /** Change an event; only the given fields change. */
  async updateEvent(
    url: string,
    etag: string,
    patch: EventPatch,
  ): Promise<EngineResult<WriteResult & { event: EventDetail }>> {
    const now = this.#now()
    const edited = await this.#edit<CalendarEvent>(url, etag, (root) => {
      const patched = patchEvent(root, patch, { now })
      return patched.success ? ok(patched.output) : icalFail(patched)
    })
    if (!edited.success) return edited
    const { write, result } = edited.output
    return ok({ ...write, event: eventDetail(result, write.url, write.etag) })
  }

  /** Create a calendar under the user's calendar home. */
  async makeCalendar(
    displayName: string,
    components: string[],
    color?: string,
  ): Promise<EngineResult<{ url: string; displayName: string }>> {
    const homes = await this.#homeUrls()
    if (!homes.success) return homes
    const made = await this.#client.makeCalendar(homes.output[0]!, {
      displayName,
      components,
      color,
    })
    return made.success ? ok({ url: made.output.url, displayName }) : caldavFail(made)
  }

  /** Delete a calendar that `listCalendars` returns, with everything in it. */
  async deleteCalendar(url: string): Promise<EngineResult<{ url: string }>> {
    const calendar = await this.#knownCalendar(url)
    if (!calendar.success) return calendar
    const deleted = await this.#client.deleteCalendar(calendar.output.url)
    this.#calendarCache = undefined
    return deleted.success ? ok({ url: calendar.output.url }) : caldavFail(deleted)
  }
}

