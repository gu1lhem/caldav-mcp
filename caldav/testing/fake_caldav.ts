// ── In-memory CalDAV server for tests ──
// Answers the requests `@spy4x/caldav` sends, in Stalwart's shape: `D:` and `A:` prefixes, etags
// entity-encoded (`&quot;`), calendar data in CDATA, resource names unlike UIDs. It records every
// request, so a test can check where the login went.

export const ORIGIN = 'https://dav.example.com'
export const USER = 'user@example.com'
export const PASSWORD = 'not-a-real-password'
export const AUTH = `Basic ${btoa(`${USER}:${PASSWORD}`)}`
export const PRINCIPAL = '/dav/principal/user%40example.com/'
export const HOME = '/dav/cal/user%40example.com/'

export interface FakeObject {
  etag: string
  data: string
}

export interface FakeCalendar {
  displayName: string
  components: string[]
}

export interface RecordedRequest {
  method: string
  url: string
  authorization: string | null
  headers: Record<string, string>
  body: string
}

/** A fake server: its `fetch`, its state and every request it saw. */
export interface FakeCalDav {
  fetch: typeof fetch
  requests: RecordedRequest[]
  calendars: Map<string, FakeCalendar>
  /** Object path → etag and data. */
  objects: Map<string, FakeObject>
  /** When false, PUT answers without an ETag header (allowed by RFC 4791). */
  sendEtagOnPut: boolean
}

function xmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function multistatus(responses: string[]): Response {
  const body = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav">' +
    responses.join('') + '</D:multistatus>'
  return new Response(body, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}

function ok(href: string, props: string): string {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${props}</D:prop>` +
    '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
}

function calendarProps(calendar: FakeCalendar): string {
  const comps = calendar.components.map((c) => `<A:comp name="${c}"/>`).join('')
  return '<D:resourcetype><D:collection/><A:calendar/></D:resourcetype>' +
    `<D:displayname>${xmlEscape(calendar.displayName)}</D:displayname>` +
    `<A:supported-calendar-component-set>${comps}</A:supported-calendar-component-set>`
}

function parentPath(path: string): string {
  return path.replace(/[^/]+\/?$/, '')
}

/** A server with the given calendars (path → calendar) and objects (path → object). */
export function createFakeCalDav(
  calendars: Record<string, FakeCalendar> = {},
  objects: Record<string, FakeObject> = {},
): FakeCalDav {
  let nextEtag = 1000
  const fake: FakeCalDav = {
    requests: [],
    calendars: new Map(Object.entries(calendars)),
    objects: new Map(Object.entries(objects)),
    sendEtagOnPut: true,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const body = await request.text()
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => (headers[key] = value))
      fake.requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('Authorization'),
        headers,
        body,
      })
      if (url.origin !== ORIGIN) return new Response('elsewhere', { status: 200 })
      if (request.headers.get('Authorization') !== AUTH) return new Response(null, { status: 401 })
      return handle(request.method, url.pathname, request.headers, body)
    },
  }

  const newEtag = () => `"${nextEtag++}"`

  function handle(method: string, path: string, headers: Headers, body: string): Response {
    const calendar = fake.calendars.get(path)
    const object = fake.objects.get(path)
    switch (method) {
      case 'PROPFIND': {
        if (body.includes('calendar-home-set')) {
          return multistatus([
            ok(PRINCIPAL, `<A:calendar-home-set><D:href>${HOME}</D:href></A:calendar-home-set>`),
          ])
        }
        if (body.includes('current-user-principal')) {
          return multistatus([
            ok(
              path,
              `<D:current-user-principal><D:href>${PRINCIPAL}</D:href></D:current-user-principal>`,
            ),
          ])
        }
        if (path === HOME) {
          const entries = [ok(HOME, '<D:resourcetype><D:collection/></D:resourcetype>')]
          for (const [calendarPath, c] of fake.calendars) {
            if (parentPath(calendarPath) === HOME) entries.push(ok(calendarPath, calendarProps(c)))
          }
          return multistatus(entries)
        }
        if (calendar) return multistatus([ok(path, calendarProps(calendar))])
        return new Response(null, { status: 404 })
      }
      case 'REPORT': {
        if (!calendar) return new Response(null, { status: 404 })
        const component = /comp-filter name="(V[A-Z]+)"/g
        const names = [...body.matchAll(component)].map((m) => m[1])
        const wanted = names.at(-1) ?? 'VTODO'
        const openOnly = body.includes('is-not-defined')
        const entries: string[] = []
        for (const [objectPath, o] of fake.objects) {
          if (parentPath(objectPath) !== path) continue
          if (!o.data.includes(`BEGIN:${wanted}`)) continue
          if (openOnly && /^COMPLETED[:;]/m.test(o.data)) continue
          entries.push(ok(
            objectPath,
            `<D:getetag>${xmlEscape(o.etag)}</D:getetag>` +
              `<A:calendar-data><![CDATA[${o.data}]]></A:calendar-data>`,
          ))
        }
        return multistatus(entries)
      }
      case 'GET':
        if (!object) return new Response(null, { status: 404 })
        return new Response(object.data, {
          status: 200,
          headers: { 'Content-Type': 'text/calendar', ETag: object.etag },
        })
      case 'PUT': {
        if (!fake.calendars.has(parentPath(path))) return new Response(null, { status: 409 })
        if (headers.get('If-None-Match') === '*' && object) {
          return new Response(null, { status: 412 })
        }
        const ifMatch = headers.get('If-Match')
        if (ifMatch !== null && ifMatch !== object?.etag) {
          return new Response(null, { status: 412 })
        }
        const etag = newEtag()
        fake.objects.set(path, { etag, data: body })
        return new Response(null, {
          status: object ? 204 : 201,
          headers: fake.sendEtagOnPut ? { ETag: etag } : {},
        })
      }
      case 'DELETE': {
        if (calendar) {
          fake.calendars.delete(path)
          for (const objectPath of [...fake.objects.keys()]) {
            if (parentPath(objectPath) === path) fake.objects.delete(objectPath)
          }
          return new Response(null, { status: 204 })
        }
        if (!object) return new Response(null, { status: 404 })
        if (headers.get('If-Match') !== object.etag) return new Response(null, { status: 412 })
        fake.objects.delete(path)
        return new Response(null, { status: 204 })
      }
      case 'MKCALENDAR': {
        // Stalwart creates calendars only directly under the calendar home.
        if (parentPath(path) !== HOME) return new Response(null, { status: 404 })
        const name = /displayname[^>]*>([^<]*)</.exec(body)?.[1] ?? ''
        const comps = [...body.matchAll(/comp name="(V[A-Z]+)"/g)].map((m) => m[1]!)
        fake.calendars.set(path, { displayName: name, components: comps })
        return new Response(null, { status: 201 })
      }
    }
    return new Response(null, { status: 405 })
  }

  return fake
}
