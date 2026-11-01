// ── Time ranges applied here instead of by the server ──
// A calendar subscription is read whole (`readSubscription`), so the time range the server applies
// to a normal calendar's REPORT is applied here, with the same rule (RFC 4791 §9.9): an event is in
// the range when one of its instances overlaps it. When the answer is unsure, the event is kept: a
// missing event is a silent wrong answer, an extra one is one the model can see and skip.

import {
  getProperty,
  type IcalComponent,
  IcalDateKind,
  type IcalDateValue,
  readDate,
  resolveInstant,
} from '@spy4x/time/ical'
import { durationMs, readDuration } from '@spy4x/time/ical-duration'
import { nextOccurrence, parseRrule } from '@spy4x/time/rrule'

const DAY_MS = 86_400_000

/** A range of instants; a missing side is open. The end is exclusive. */
export interface TimeRange {
  start?: Date
  end?: Date
}

/** Milliseconds of a non-negative DURATION, or `undefined` when it cannot be read. */
function lengthMs(text: string): number | undefined {
  const duration = readDuration(text)
  return duration && !duration.negative ? durationMs(duration) : undefined
}

/** When one instance starts and how long it lasts; `ms` is unknown when its end cannot be read. */
interface Span {
  value: IcalDateValue
  start: Date
  ms: number | undefined
}

function spanOf(event: IcalComponent, zone: string): Span | undefined {
  const dtstart = getProperty(event, 'DTSTART')
  const value = dtstart && readDate(dtstart)
  const start = value && resolveInstant(value, { zone })
  if (!value || !start) return undefined
  const dtend = getProperty(event, 'DTEND')
  if (dtend) {
    const endValue = readDate(dtend)
    const end = endValue && resolveInstant(endValue, { zone })
    return { value, start, ms: end && end.getTime() - start.getTime() }
  }
  const duration = getProperty(event, 'DURATION')
  if (duration) return { value, start, ms: lengthMs(duration.value) }
  // RFC 5545 §3.6.1: no end means one day for a date, the moment itself for a time.
  return { value, start, ms: value.kind === IcalDateKind.Date ? DAY_MS : 0 }
}

/** Whether an instance overlaps the range; one with an unknown end counts once it has started. */
function overlaps(start: Date, ms: number | undefined, range: TimeRange): boolean {
  if (range.end && start >= range.end) return false
  if (!range.start || ms === undefined) return true
  return ms > 0 ? start.getTime() + ms > range.start.getTime() : start >= range.start
}

/**
 * Whether the event in `root` (a master VEVENT and its RECURRENCE-ID overrides) has an instance in
 * `range`. Dates and floating times are read in `zone`. Kept, never dropped, when its start, end
 * or repeat rule cannot be read, when it repeats by RDATE (not expanded here), and when EXDATE
 * removes the instance found (EXDATE is not read): each of those may be in range.
 */
export function eventInRange(root: IcalComponent, range: TimeRange, zone: string): boolean {
  const events = root.components.filter((c) => c.name === 'VEVENT')
  const master = events.find((c) => getProperty(c, 'RECURRENCE-ID') === undefined)
  for (const override of events) {
    if (override === master) continue
    const span = spanOf(override, zone)
    if (!span || overlaps(span.start, span.ms, range)) return true
  }
  const span = master && spanOf(master, zone)
  if (!span) return true
  if (overlaps(span.start, span.ms, range)) return true
  // No instance comes before the first one, which was just checked.
  if (!range.start || span.ms === undefined || (range.end && span.start >= range.end)) return false
  if (getProperty(master!, 'RDATE')) return true
  const rrule = getProperty(master!, 'RRULE')
  if (!rrule) return false
  const rule = parseRrule(rrule.value)
  if (!rule.success) return true
  // The first instance starting after this point is the first that can still overlap the range.
  const after = new Date(range.start.getTime() - Math.max(span.ms, 1))
  const next = nextOccurrence(rule.output, { start: span.value, after, timeZone: zone })
  if (!next.success) return true
  if (next.output === null) return false
  const at = resolveInstant(next.output, { zone })
  return !at || !range.end || at < range.end
}
