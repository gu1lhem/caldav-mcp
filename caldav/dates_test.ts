// ── Date text tests ──

import { assertEquals } from 'std/assert/mod.ts'
import { IcalDateKind } from '@spy4x/time/ical'
import { dueInstant, formatIcalDate, parseDateArg } from './dates.ts'

Deno.test('each date kind reads back as the kind it was written', () => {
  for (
    const text of [
      '2026-10-12',
      '2026-10-12T09:30:00Z',
      '2026-10-12T09:30:00',
      '2026-10-12T09:30:00[Asia/Ho_Chi_Minh]',
    ]
  ) {
    assertEquals(formatIcalDate(parseDateArg(text)!), text)
  }
})

Deno.test('a time with an offset is converted to UTC', () => {
  assertEquals(parseDateArg('2026-10-12T09:30+07:00'), {
    kind: IcalDateKind.Utc,
    date: '2026-10-12',
    time: '02:30:00',
  })
})

Deno.test('an impossible date or an offset with a zone is refused', () => {
  assertEquals(parseDateArg('2026-02-30'), undefined)
  assertEquals(parseDateArg('2026-10-12T24:00:00Z'), undefined)
  assertEquals(parseDateArg('2026-10-12T09:00:00+07:00[Asia/Ho_Chi_Minh]'), undefined)
  assertEquals(parseDateArg('next tuesday'), undefined)
})

Deno.test('a date-only due date passes at the end of that day in the zone', () => {
  const due = dueInstant({ kind: IcalDateKind.Date, date: '2026-10-12' }, 'Asia/Ho_Chi_Minh')
  assertEquals(due?.toISOString(), '2026-10-12T17:00:00.000Z')
})
