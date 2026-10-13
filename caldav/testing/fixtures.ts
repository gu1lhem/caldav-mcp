// ── Recorded-shape fixtures ──
// Modelled on tasks Tasks.org (via DAVx5) wrote to Stalwart, with the text anonymised. Resource
// names differ from UIDs, as they do for every task Tasks.org creates.

import { createCalDavClient } from '@spy4x/caldav';
import { type EngineOptions, QueryEngine } from '../query.ts';
import { createFakeCalDav, type FakeCalDav, HOME, ORIGIN, PASSWORD, USER } from './fake_caldav.ts';

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

export const TASKS = `${HOME}tasks/`;
export const EVENTS = `${HOME}events/`;
export const NOW = new Date('2026-10-09T10:00:00Z');
export const ZONE = 'Asia/Ho_Chi_Minh';

/** A repeating Tasks.org task with a reminder, a parent, tags, sort order and vendor lines. */
export const TASKS_ORG_PATH = `${TASKS}AB12CD34-9999.ics`;
export const TASKS_ORG_ETAG = '"424081823"';
export const TASKS_ORG = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:+//IDN tasks.org//android-130804//EN',
  'BEGIN:VTODO',
  'DTSTAMP:20261001T080000Z',
  'UID:4417296204870311458',
  'CREATED:20260901T080000Z',
  'LAST-MODIFIED:20261001T080000Z',
  'SUMMARY:Water the plants',
  'CATEGORIES:home\\,garden',
  'CATEGORIES:weekly',
  'PRIORITY:5',
  'STATUS:NEEDS-ACTION',
  'X-APPLE-SORT-ORDER:-1',
  'RELATED-TO:5521066201873304501',
  'DTSTART;VALUE=DATE:20261010',
  'DUE;VALUE=DATE:20261012',
  'RRULE:FREQ=WEEKLY;INTERVAL=1',
  'URL:https://evil.example/steal',
  'X-MOZ-LASTACK:20261001T080000Z',
  'BEGIN:VALARM',
  'TRIGGER;RELATED=END;VALUE=DURATION:PT0S',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder text',
  'END:VALARM',
  'END:VTODO',
  'END:VCALENDAR',
]);

/** A one-off task due at a wall-clock time in a named zone, with its VTIMEZONE. */
export const ZONED_PATH = `${TASKS}7f3e-zoned.ics`;
export const ZONED_ETAG = '"77"';
export const ZONED = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:+//IDN tasks.org//android-130804//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Ho_Chi_Minh',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0700',
  'TZOFFSETTO:+0700',
  'TZNAME:+07',
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VTODO',
  'DTSTAMP:20261001T080000Z',
  'UID:zoned-task-uid',
  'CREATED:20260901T080000Z',
  'SUMMARY:Call the bank',
  'STATUS:NEEDS-ACTION',
  'DUE;TZID=Asia/Ho_Chi_Minh:20261008T090000',
  'END:VTODO',
  'END:VCALENDAR',
]);

/** A completed one-off task. */
export const DONE_PATH = `${TASKS}done-1.ics`;
export const DONE_ETAG = '"55"';
export const DONE = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:+//IDN tasks.org//android-130804//EN',
  'BEGIN:VTODO',
  'DTSTAMP:20261001T080000Z',
  'UID:done-task-uid',
  'SUMMARY:Renew the passport',
  'DESCRIPTION:Bring two photos',
  'STATUS:COMPLETED',
  'COMPLETED:20261001T080000Z',
  'PERCENT-COMPLETE:100',
  'END:VTODO',
  'END:VCALENDAR',
]);

/** A weekly meeting with guests, a reminder and a time zone. */
export const MEETING_PATH = `${EVENTS}meeting-file.ics`;
export const MEETING_ETAG = '"900"';
export const MEETING = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//Calendar//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:team-sync',
  'DTSTAMP:20260701T120000Z',
  'SUMMARY:Team sync',
  'DTSTART;TZID=Europe/Berlin:20261013T120000',
  'DTEND;TZID=Europe/Berlin:20261013T130000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=20',
  'ORGANIZER:mailto:lead@example.com',
  'ATTENDEE;CN=Guest:mailto:guest@example.com',
  'URL:https://evil.example/meeting',
  'SEQUENCE:2',
  'BEGIN:VALARM',
  'TRIGGER:-PT15M',
  'ACTION:DISPLAY',
  'DESCRIPTION:ping',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
]);

export interface Setup {
  fake: FakeCalDav;
  engine: QueryEngine;
}

/**
 * The fake server with every fixture, and an engine on it with a fixed clock, zone and UID.
 * `options` replaces any of the three; `{ uid: undefined }` gives the engine's own UID generator.
 */
export function setup(options: EngineOptions = {}): Setup {
  const fake = createFakeCalDav(
    {
      [TASKS]: { displayName: 'Inbox', components: ['VTODO'] },
      [EVENTS]: { displayName: 'Meetings', components: ['VEVENT'] },
    },
    {
      [TASKS_ORG_PATH]: { etag: TASKS_ORG_ETAG, data: TASKS_ORG },
      [ZONED_PATH]: { etag: ZONED_ETAG, data: ZONED },
      [DONE_PATH]: { etag: DONE_ETAG, data: DONE },
      [MEETING_PATH]: { etag: MEETING_ETAG, data: MEETING },
    },
  );
  const client = createCalDavClient({
    serverUrl: `${ORIGIN}/dav/`,
    auth: { username: USER, password: PASSWORD },
    fetch: (input, init) => fake.fetch(input, init),
  });
  const engine = new QueryEngine(client, {
    now: () => NOW,
    zone: ZONE,
    uid: () => 'new-uid-1',
    ...options,
  });
  return { fake, engine };
}

/** Lines of `after` not in `before`, and of `before` not in `after`, after unfolding. */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
  const a = lines(before);
  const b = lines(after);
  return {
    added: b.filter((line) => !a.includes(line)),
    removed: a.filter((line) => !b.includes(line)),
  };
}
