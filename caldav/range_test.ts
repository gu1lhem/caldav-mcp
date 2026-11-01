import { assertEquals } from 'std/assert/mod.ts'
import { parseIcal } from '@spy4x/time/ical'
import { eventInRange, type TimeRange } from './range.ts'

const ZONE = 'UTC'
const OCTOBER: TimeRange = {
  start: new Date('2026-10-10T00:00:00Z'),
  end: new Date('2026-10-20T00:00:00Z'),
}

/** A VCALENDAR with one VEVENT per list of lines. */
function calendar(...events: string[][]) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0']
  for (const event of events) lines.push('BEGIN:VEVENT', 'UID:e1', ...event, 'END:VEVENT')
  lines.push('END:VCALENDAR')
  const parsed = parseIcal(lines.join('\r\n') + '\r\n')
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.output
}

const inOctober = (...events: string[][]) => eventInRange(calendar(...events), OCTOBER, ZONE)

Deno.test('an event that ends at the range start is out, one that ends after it is in', () => {
  assertEquals(inOctober(['DTSTART:20261009T220000Z', 'DTEND:20261010T000000Z']), false)
  assertEquals(inOctober(['DTSTART:20261009T220000Z', 'DTEND:20261010T000100Z']), true)
})

Deno.test('an event with DURATION lasts that long', () => {
  assertEquals(inOctober(['DTSTART:20261009T230000Z', 'DURATION:PT1H']), false)
  assertEquals(inOctober(['DTSTART:20261009T230000Z', 'DURATION:PT2H']), true)
})

Deno.test('a DURATION in any case is read, and an unreadable or negative one keeps the event', () => {
  assertEquals(inOctober(['DTSTART:20261009T230000Z', 'DURATION:pt1h']), false)
  assertEquals(inOctober(['DTSTART:20261001T090000Z', 'DURATION:soon']), true)
  assertEquals(inOctober(['DTSTART:20261001T090000Z', 'DURATION:-PT1H']), true)
})

Deno.test('a zero-length event at the range start is in, one at its end is out', () => {
  assertEquals(inOctober(['DTSTART:20261010T000000Z']), true)
  assertEquals(inOctober(['DTSTART:20261020T000000Z']), false)
})

Deno.test('a repeating event is in by a later instance, and out once COUNT ends it', () => {
  assertEquals(inOctober(['DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=MONTHLY']), true)
  assertEquals(inOctober(['DTSTART;VALUE=DATE:20260915', 'RRULE:FREQ=MONTHLY;COUNT=1']), false)
})

Deno.test('an override moved into the range keeps the event', () => {
  const master = ['DTSTART:20260901T090000Z', 'RRULE:FREQ=DAILY;COUNT=2']
  const moved = ['RECURRENCE-ID:20260902T090000Z', 'DTSTART:20261012T090000Z']
  assertEquals(inOctober(master), false)
  assertEquals(inOctober(master, moved), true)
})

Deno.test('an event whose start or end cannot be resolved is kept', () => {
  assertEquals(inOctober(['DTSTART;TZID=Mars/Olympus:20260101T090000']), true)
  assertEquals(inOctober(['DTSTART:20261001T090000Z', 'DTEND:not-a-date']), true)
  assertEquals(inOctober(['DTSTART:20261001T090000Z', 'RRULE:FREQ=SOMETIMES']), true)
})

Deno.test('a repeating instance that starts before the range and runs into it is in', () => {
  const monthly = ['DTSTART:20260809T230000Z', 'DTEND:20260810T010000Z', 'RRULE:FREQ=MONTHLY']
  assertEquals(inOctober(monthly), true)
  assertEquals(inOctober([...monthly.slice(0, 2), 'RRULE:FREQ=MONTHLY;COUNT=2']), false)
})

Deno.test('an event repeating by RDATE is kept, since RDATE dates are not read', () => {
  assertEquals(inOctober(['DTSTART:20260901T090000Z', 'RDATE:20261012T090000Z']), true)
})
