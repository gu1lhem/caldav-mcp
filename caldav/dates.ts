// ── Dates as the tools show and accept them ──
// A task's date keeps its iCalendar kind (date, floating, UTC, zoned) through a round trip, so a
// date-only due date never turns into a timed one.

import { IcalDateKind, type IcalDateValue, resolveInstant } from '@spy4x/time/ical'

const DAY_MS = 86_400_000

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?(?:\[([^\]\s]+)\])?$/

/**
 * Show a date value as text: `2026-10-12` (date), `2026-10-12T09:00:00Z` (UTC),
 * `2026-10-12T09:00:00` (floating) or `2026-10-12T09:00:00[Asia/Ho_Chi_Minh]` (zoned).
 */
export function formatIcalDate(value: IcalDateValue): string {
  switch (value.kind) {
    case IcalDateKind.Date:
      return value.date
    case IcalDateKind.Utc:
      return `${value.date}T${value.time}Z`
    case IcalDateKind.Zoned:
      return `${value.date}T${value.time}[${value.tzid}]`
    default:
      return `${value.date}T${value.time}`
  }
}

function validDate(date: string): boolean {
  const match = DATE_ONLY.exec(date)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
}

/**
 * Read a date the way {@link formatIcalDate} writes it. A time with an offset such as `+07:00` is
 * converted to UTC. Returns `undefined` for anything else, including an offset combined with a
 * `[Zone]`.
 */
export function parseDateArg(text: string): IcalDateValue | undefined {
  const trimmed = text.trim()
  if (DATE_ONLY.test(trimmed)) {
    return validDate(trimmed) ? { kind: IcalDateKind.Date, date: trimmed } : undefined
  }
  const match = DATE_TIME.exec(trimmed)
  if (!match) return undefined
  const [, date, hours, minutes, seconds = '00', offset, zone] = match
  if (!validDate(date!) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    return undefined
  }
  const time = `${hours}:${minutes}:${seconds}`
  if (offset && zone) return undefined
  if (zone) return { kind: IcalDateKind.Zoned, date: date!, time, tzid: zone }
  if (offset === 'Z') return { kind: IcalDateKind.Utc, date: date!, time }
  if (!offset) return { kind: IcalDateKind.Floating, date: date!, time }
  const instant = new Date(`${date}T${time}${offset}`)
  if (Number.isNaN(instant.getTime())) return undefined
  const iso = instant.toISOString()
  return { kind: IcalDateKind.Utc, date: iso.slice(0, 10), time: iso.slice(11, 19) }
}

/**
 * The instant a date value starts at. Dates and floating times are read in `zone`; a zoned time
 * whose TZID is not an IANA zone has no instant.
 */
export function startInstant(value: IcalDateValue, zone: string): Date | undefined {
  return resolveInstant(value, { zone })
}

/**
 * The instant a due date has passed: the end of the day for a date-only value, the moment itself
 * otherwise. A task due "2026-10-12" is not overdue until that day is over in `zone`.
 */
export function dueInstant(value: IcalDateValue, zone: string): Date | undefined {
  const start = resolveInstant(value, { zone })
  if (!start || value.kind !== IcalDateKind.Date) return start
  return new Date(start.getTime() + DAY_MS)
}
