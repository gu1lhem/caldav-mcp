// ── Shapes the tools return ──
// Dates are text as `formatIcalDate` writes them; statuses are their iCalendar names.

/** A failed engine call: a stable code for the model to branch on, and a message. */
export interface EngineError {
  /** A `CalDavErrorCode` name such as `Conflict` or `NotFound`, or one of the engine's own. */
  code: string
  message: string
}

/** `{ success, output, error }`, the shape every engine call returns. */
export type EngineResult<T> =
  | { success: true; output: T; error: null }
  | { success: false; output: null; error: EngineError }

export interface CalendarInfo {
  url: string
  displayName: string
  /** Component names it accepts, such as `VTODO`; empty means any. */
  components: string[]
  color?: string
  ctag?: string
  /** Present and true when the calendar is a server subscription to an external feed. */
  subscribed?: true
}

/** One task in a `query_todos` list. */
export interface TodoSummary {
  url: string
  etag: string | null
  summary?: string
  status?: string
  due?: string
  priority?: number
  /** Present and true when the task has a repeat rule. */
  repeats?: true
  calendar: string
}

/** Everything the tools show about one task. */
export interface TodoDetail {
  url: string
  etag: string | null
  calendarUrl: string
  uid?: string
  summary?: string
  description?: string
  status?: string
  priority?: number
  start?: string
  due?: string
  completed?: string
  percentComplete?: number
  categories: string[]
  /** The UID of the parent task (RELATED-TO without RELTYPE, or RELTYPE=PARENT). */
  parent?: string
  relatedTo: { uid: string; type: string }[]
  rrule?: string
  sortOrder?: number
  /** Reminders, read-only: action and trigger as written. */
  reminders: { action?: string; trigger?: string }[]
}

export interface TodoQueryResult {
  /** Tasks matching the filters, before `limit`. */
  total: number
  byStatus: Record<string, number>
  byPriority: { high: number; medium: number; low: number; none: number }
  overdue: number
  /** True when `todos` holds fewer than `total`. */
  truncated: boolean
  todos: (TodoSummary | TodoDetail)[]
  /** Objects whose iCalendar text could not be read, so they are not counted. */
  unreadable?: number
  /** Calendars that could not be read; the counts above leave them out. */
  failedCalendars?: { url: string; code: string; message: string }[]
}

export interface EventSummary {
  url: string
  etag: string | null
  summary?: string
  start?: string
  end?: string
  location?: string
  status?: string
  repeats?: true
  calendar: string
}

export interface EventDetail {
  url: string
  etag: string | null
  calendarUrl: string
  summary?: string
  start?: string
  end?: string
  location?: string
  status?: string
  repeats?: true
  uid?: string
  description?: string
  duration?: string
  categories: string[]
  rrule?: string
  reminders: { action?: string; trigger?: string }[]
}

export interface EventQueryResult {
  total: number
  upcoming: number
  truncated: boolean
  events: EventSummary[]
  unreadable?: number
  failedCalendars?: { url: string; code: string; message: string }[]
}

/** The outcome of a write: where the object is and the etag to use for the next write. */
export interface WriteResult {
  url: string
  /** `null` when the server sent none and a re-read failed; call get_todo/get_event for it. */
  etag: string | null
}
