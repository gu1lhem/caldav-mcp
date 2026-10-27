// ── Calendar subscriptions: the wrapper of `subscriptions.ts` against a fake server ──

import {
  type CalDavCalendar,
  type CalDavClient,
  CalDavErrorCode,
  type CalDavObject,
} from '@spy4x/caldav'
import { parseIcal } from '@spy4x/time/ical'
import { assertEquals, assertStringIncludes } from 'std/assert/mod.ts'
import { isSubscribed, withSubscriptions } from './subscriptions.ts'

const HOME = 'https://cal.example.com/remote.php/dav/calendars/user/'
const REAL = 'https://cal.example.com/remote.php/dav/calendars/user/real/'
const FEED = 'https://cal.example.com/remote.php/dav/calendars/user/external/'

/** One calendar the library's client lists: no subscription, the case it is built for. */
const realCalendar: CalDavCalendar = {
  url: REAL,
  displayName: 'Personal',
  components: ['VEVENT', 'VTODO'],
}

const LISTING = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
    xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/remote.php/dav/calendars/user/real/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>Personal</d:displayname>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/user/external/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cs:subscribed/></d:resourcetype>
        <d:displayname>External feed</d:displayname>
        <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

const EXPORT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//EN',
  'CALSCALE:GREGORIAN',
  'BEGIN:VEVENT',
  'UID:past-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20261101T100000Z',
  'DTEND:20261101T110000Z',
  'SUMMARY:Past event',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:future-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20270301T090000Z',
  'DTEND:20270301T100000Z',
  'SUMMARY:Future event',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

/** A `fetch` that answers the two requests the wrapper makes, and fails anything else. */
function fakeFetch(handlers: {
  propfind?: () => Response
  export?: () => Response
} = {}): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(`${input}`)
    const method = init?.method ?? 'GET'
    if (method === 'PROPFIND') {
      return Promise.resolve(handlers.propfind?.() ?? new Response(LISTING, { status: 207 }))
    }
    if (url.search === '?export') {
      return Promise.resolve(handlers.export?.() ?? new Response(EXPORT, { status: 200 }))
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  }
}

/** A base client that lists one real calendar and refuses to be called for a subscription. */
function fakeClient(): CalDavClient & { calls: string[] } {
  const calls: string[] = []
  const refused = () => {
    throw new Error('the base client was called for a subscription')
  }
  const client: CalDavClient & { calls: string[] } = {
    calls,
    discover: () => Promise.reject(new Error('not used in these tests')),
    listCalendars: () => {
      calls.push('listCalendars')
      return Promise.resolve({
        success: true as const,
        output: [{ ...realCalendar }],
        error: null,
      })
    },
    listObjects: () => {
      calls.push('listObjects')
      return Promise.resolve({
        success: true as const,
        output: [] as CalDavObject[],
        error: null,
      })
    },
    getObjects: refused as never,
    getObject: refused as never,
    createObject: () => {
      calls.push('createObject')
      return Promise.resolve({
        success: true as const,
        output: { url: `${REAL}made.ics`, etag: '"1"' },
        error: null,
      })
    },
    updateObject: refused as never,
    deleteObject: refused as never,
    makeCalendar: refused as never,
    updateCalendar: refused as never,
    deleteCalendar: refused as never,
  }
  return client
}

function wrapped(handlers: Parameters<typeof fakeFetch>[0] = {}) {
  const base = fakeClient()
  const client = withSubscriptions(base, {
    serverUrl: 'https://cal.example.com',
    auth: { username: 'user', password: 'secret' },
    fetch: fakeFetch(handlers),
  })
  return { base, client }
}

Deno.test('listCalendars merges the subscriptions of the home, marked subscribed', async () => {
  const { client } = wrapped()
  const listed = await client.listCalendars(HOME)
  assertEquals(listed.success, true)
  if (!listed.success) return
  assertEquals(listed.output.length, 2)
  const feed = listed.output.find((calendar) => calendar.displayName === 'External feed')
  assertEquals(feed?.url, FEED)
  assertEquals(isSubscribed(feed!), true)
  assertEquals(feed?.components, ['VEVENT'])
  assertEquals(isSubscribed(listed.output[0]!), false)
})

Deno.test("listCalendars keeps the library's list when the listing fails", async () => {
  const { client } = wrapped({ propfind: () => new Response('no', { status: 500 }) })
  const listed = await client.listCalendars(HOME)
  assertEquals(listed.success, true)
  if (!listed.success) return
  assertEquals(listed.output.length, 1)
  assertEquals(listed.output[0]?.displayName, 'Personal')
})

Deno.test('listObjects splits the export of a subscription into virtual objects', async () => {
  const { client } = wrapped()
  await client.listCalendars(HOME)
  const objects = await client.listObjects(FEED, { component: 'VEVENT' })
  assertEquals(objects.success, true)
  if (!objects.success) return
  assertEquals(objects.output.length, 2)
  const first = objects.output[0]!
  assertEquals(first.url, `${FEED}past-1.ics`)
  assertEquals(first.etag, null)
  const parsed = parseIcal(first.data)
  assertEquals(parsed.success, true)
  if (!parsed.success) return
  assertEquals(parsed.output.name, 'VCALENDAR')
  assertEquals(parsed.output.components[0]?.name, 'VEVENT')
})

Deno.test('listObjects filters a subscription by the time range', async () => {
  const { client } = wrapped()
  await client.listCalendars(HOME)
  const objects = await client.listObjects(FEED, {
    component: 'VEVENT',
    timeRange: { start: new Date('2027-01-01T00:00:00Z') },
  })
  assertEquals(objects.success, true)
  if (!objects.success) return
  assertEquals(objects.output.length, 1)
  assertEquals(objects.output[0]?.url, `${FEED}future-1.ics`)
})

Deno.test('getObject reads a virtual object of a subscription by its UID', async () => {
  const { client } = wrapped()
  await client.listCalendars(HOME)
  const got = await client.getObject(`${FEED}future-1.ics`)
  assertEquals(got.success, true)
  if (!got.success) return
  assertEquals(got.output.url, `${FEED}future-1.ics`)
  assertEquals(got.output.etag, null)
  const parsed = parseIcal(got.output.data)
  assertEquals(parsed.success, true)
  if (!parsed.success) return
  const summary = parsed.output.components[0]?.properties.find((p) => p.name === 'SUMMARY')
  assertEquals(summary?.value, 'Future event')
})

Deno.test('getObject of an unknown UID of a subscription fails NotFound', async () => {
  const { client } = wrapped()
  await client.listCalendars(HOME)
  const got = await client.getObject(`${FEED}unknown.ics`)
  assertEquals(got.success, false)
  if (got.success) return
  assertEquals(got.error.code, CalDavErrorCode.NotFound)
})

Deno.test('writes to a subscription are refused as read-only', async () => {
  const { client } = wrapped()
  await client.listCalendars(HOME)
  const refusals = await Promise.all([
    client.createObject(FEED, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
    client.updateObject(`${FEED}future-1.ics`, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', '"1"'),
    client.deleteObject(`${FEED}future-1.ics`, '"1"'),
    client.deleteCalendar(FEED),
  ])
  for (const refused of refusals) {
    assertEquals(refused.success, false)
    if (refused.success) continue
    assertEquals(refused.error.code, CalDavErrorCode.InvalidArgument)
    assertStringIncludes(refused.error.message, 'read-only')
  }
})

Deno.test('a component whose UID cannot name a member is skipped, not thrown', async () => {
  const { client } = wrapped({
    export: () =>
      new Response(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:..',
          'DTSTART:20270301T090000Z',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:ok-1',
          'DTSTART:20270301T090000Z',
          'END:VEVENT',
          'END:VCALENDAR',
          '',
        ].join('\r\n'),
        { status: 200 },
      ),
  })
  await client.listCalendars(HOME)
  const objects = await client.listObjects(FEED, { component: 'VEVENT' })
  assertEquals(objects.success, true)
  if (!objects.success) return
  assertEquals(objects.output.length, 1)
  assertEquals(objects.output[0]?.url, `${FEED}ok-1.ics`)
})

Deno.test('getObject of a malformed address fails InvalidArgument, not by throwing', async () => {
  const { client } = wrapped()
  await client.listCalendars(HOME)
  const got = await client.getObject(`${FEED}%zz.ics`)
  assertEquals(got.success, false)
  if (got.success) return
  assertEquals(got.error.code, CalDavErrorCode.InvalidArgument)
})

Deno.test('an http: serverUrl is refused before any request', () => {
  let threw = false
  try {
    withSubscriptions(fakeClient(), {
      serverUrl: 'http://cal.example.com',
      auth: { username: 'user', password: 'secret' },
      fetch: fakeFetch(),
    })
  } catch {
    threw = true
  }
  assertEquals(threw, true)
})

Deno.test('a real calendar still goes to the wrapped client', async () => {
  const { base, client } = wrapped()
  await client.listCalendars(HOME)
  const made = await client.createObject(REAL, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
  assertEquals(made.success, true)
  assertEquals(base.calls, ['listCalendars', 'createObject'])
})
