// ── Calendar subscriptions (`cs:subscribed`) ──
// Nextcloud and other calendar servers let a user subscribe to an external ICS feed. The
// subscription appears in the calendar home as a collection marked `cs:subscribed`, which
// `@spy4x/caldav`'s `listCalendars` drops: it recognises `caldav:calendar` collections only.
// The server also serves a subscription's events only through the collection's `?export`
// endpoint: `PROPFIND` and `calendar-query` answer with no objects at all.
//
// `withSubscriptions` (below) wraps a client and closes both gaps without touching the
// library:
//
// - `listCalendars` merges the subscribed collections of the home into the library's list,
//   marked `subscribed: true`;
// - `listObjects` and `getObject` serve a subscription's events from its `?export`, split
//   client-side into one virtual object per component, at `<calendar>/<uid>.ics`;
// - every write to a subscription is refused: a subscription is read-only by nature.
//
// The export is fetched from the calendar server, never from the feed's origin, so the remote
// party keeps seeing only the server's requests, and the events are as fresh as the server's
// own copy of the feed (its refresh interval), not older.

import {
  type CalDavCalendar,
  CalDavErrorCode,
  type CalDavClient,
  type CalDavObject,
  type CalDavResult,
  type ListObjectsOptions,
} from '@spy4x/caldav'
import {
  APPLE_ICAL_NS,
  CALDAV_NS,
  CALENDARSERVER_NS,
  childElements,
  type DavResponse,
  DAV_NS,
  getProp,
  getPropText,
  parseMultistatus,
  propfindBody,
  type XmlName,
} from '@spy4x/caldav/xml'
import { childUrl, isSameOrigin, resolveHref, sameResource } from '@spy4x/caldav/url'
import {
  BodyReadTimeoutError,
  PayloadTooLargeError,
  readBoundedText,
} from '@spy4x/net/bounded-body'
import { encodeBase64 } from 'std/encoding/base64.ts'
import {
  getProperty,
  type IcalComponent,
  parseIcal,
  readDate,
  resolveInstant,
  serializeIcal,
} from '@spy4x/time/ical'

/** A calendar collection the server subscribes to on the user's behalf. */
export interface SubscribedCalendar extends CalDavCalendar {
  /** Always `true`: the collection is a subscription, and read-only. */
  subscribed: true
}

/** Whether `calendar` is one `withSubscriptions` listed from a `cs:subscribed` collection. */
export function isSubscribed(calendar: CalDavCalendar): calendar is SubscribedCalendar {
  return (calendar as Partial<SubscribedCalendar>).subscribed === true
}

/** Options of `withSubscriptions`: the same server and credentials as the wrapped client. */
export interface SubscriptionOptions {
  /** Where the server is, the value the wrapped client was created with. */
  serverUrl: string | URL
  /** HTTP Basic credentials, the value the wrapped client was created with. */
  auth: { username: string; password: string }
  /** The `fetch` to use for the subscription requests. Default: the global `fetch`. */
  fetch?: typeof fetch
  /** Largest response body read, in bytes. Default: 10 MiB. */
  maxResponseBytes?: number
  /** Time budget of one subscription request, redirects and body reads included, in ms. */
  timeoutMs?: number
}

/** A subscription's checked options, with the defaults filled in. */
interface Settings {
  server: URL
  authorization: string
  fetch: NonNullable<SubscriptionOptions['fetch']>
  maxBytes: number
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5
const XML_TYPE = 'application/xml; charset=utf-8'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The properties the subscription listing asks for, the ones a calendar is listed with. */
const SUBSCRIPTION_PROPS: XmlName[] = [
  { namespace: DAV_NS, name: 'resourcetype' },
  { namespace: DAV_NS, name: 'displayname' },
  { namespace: CALDAV_NS, name: 'supported-calendar-component-set' },
  { namespace: APPLE_ICAL_NS, name: 'calendar-color' },
]

function settingsOf(options: SubscriptionOptions): Settings {
  let server: URL
  try {
    server = new URL(options.serverUrl)
  } catch {
    throw new TypeError('serverUrl is not a valid URL')
  }
  if (server.protocol === 'http:') {
    throw new TypeError(
      'serverUrl is an http: address, which would send the password unencrypted',
    )
  }
  return {
    server,
    authorization: `Basic ${encodeBase64(`${options.auth.username}:${options.auth.password}`)}`,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    maxBytes: options.maxResponseBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function ok<T>(output: T): CalDavResult<T> {
  return { success: true, output, error: null }
}

function fail<T>(code: CalDavErrorCode, message: string): CalDavResult<T> {
  return { success: false, output: null, error: { code, message } }
}

/** One answered request. */
interface Reply {
  status: number
  text: string
}

/**
 * Send one request of a subscription call, following same-origin redirects by hand and reading
 * the body bounded. The `Authorization` header is attached to the server's origin only, and a
 * redirect to another origin is reported, never followed.
 */
async function send(
  settings: Settings,
  method: string,
  url: URL,
  headers: Record<string, string>,
  body?: string,
): Promise<CalDavResult<Reply>> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('timed out', 'TimeoutError')),
    settings.timeoutMs,
  )
  try {
    let target = url
    let verb = method
    let payload = body
    for (let hop = 0;; hop++) {
      if (!isSameOrigin(target, settings.server)) {
        return fail(
          CalDavErrorCode.OutsideServer,
          "refusing a request outside the server's origin",
        )
      }
      const response = await settings.fetch(target.href, {
        method: verb,
        headers: { ...headers, Authorization: settings.authorization },
        body: payload,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        try {
          await response.body?.cancel()
        } catch {
          // Best effort: the body of a redirect is never read.
        }
        const location = response.headers.get('Location')
        const next = location === null ? null : resolveHref(location, target)
        if (next === null) {
          return fail(CalDavErrorCode.Server, 'the server sent a redirect without a valid Location')
        }
        if (!isSameOrigin(next, settings.server)) {
          return fail(
            CalDavErrorCode.CrossOriginRedirect,
            'the server redirected to another origin',
          )
        }
        if (hop >= MAX_REDIRECTS) {
          return fail(CalDavErrorCode.TooManyRedirects, `more than ${MAX_REDIRECTS} redirects`)
        }
        if (response.status === 303) {
          verb = 'GET'
          payload = undefined
        }
        target = next
        continue
      }
      let text: string
      try {
        text = await readBoundedText(response, {
          maxBytes: settings.maxBytes,
          timeoutMs: settings.timeoutMs,
        })
      } catch (cause) {
        if (cause instanceof PayloadTooLargeError) {
          return fail(CalDavErrorCode.TooLarge, `the response is over ${settings.maxBytes} bytes`)
        }
        if (cause instanceof BodyReadTimeoutError || controller.signal.aborted) {
          return fail(CalDavErrorCode.Timeout, `no complete answer within ${settings.timeoutMs} ms`)
        }
        return fail(CalDavErrorCode.Network, 'reading the response failed')
      }
      if (response.status === 401) {
        return fail(CalDavErrorCode.Unauthorized, 'the server refused the credentials')
      }
      if (response.status === 403) {
        return fail(CalDavErrorCode.Forbidden, 'the server forbids this')
      }
      return ok({ status: response.status, text })
    }
  } catch (cause) {
    if (controller.signal.aborted) {
      return fail(CalDavErrorCode.Timeout, `no answer within ${settings.timeoutMs} ms`)
    }
    return fail(CalDavErrorCode.Network, `the request failed: ${cause}`)
  } finally {
    clearTimeout(timer)
  }
}

/** The decoded last path segment of `url`, the display-name fallback of a collection. */
function lastSegment(url: URL): string {
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const last = segments.at(-1) ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** The subscription a multistatus response describes, at `url`. */
function subscriptionOf(response: DavResponse, url: URL): SubscribedCalendar {
  const components = getProp(response, CALDAV_NS, 'supported-calendar-component-set')
  return {
    url: url.href,
    displayName: getPropText(response, DAV_NS, 'displayname')?.trim() || lastSegment(url),
    components: components === undefined ? [] : childElements(components, CALDAV_NS, 'comp')
      .map((comp) => comp.attributes.find((attribute) => attribute.name === 'name')?.value ?? '')
      .filter((name) => name !== ''),
    subscribed: true,
  }
}

/** The subscribed collections directly under one calendar home, found by an extra PROPFIND. */
async function subscribedOf(
  settings: Settings,
  home: URL,
): Promise<CalDavResult<SubscribedCalendar[]>> {
  const reply = await send(settings, 'PROPFIND', home, {
    Depth: '1',
    'Content-Type': XML_TYPE,
  }, propfindBody(SUBSCRIPTION_PROPS))
  if (!reply.success) return reply
  if (reply.output.status !== 207) {
    return fail(CalDavErrorCode.Server, `the calendar home answered ${reply.output.status}`)
  }
  const parsed = parseMultistatus(reply.output.text, { maxBytes: settings.maxBytes })
  if (!parsed.success) {
    return fail(CalDavErrorCode.Malformed, "the calendar home's answer is unreadable")
  }
  const subscriptions: SubscribedCalendar[] = []
  for (const response of parsed.output) {
    const type = getProp(response, DAV_NS, 'resourcetype')
    if (!type || childElements(type, CALENDARSERVER_NS, 'subscribed').length === 0) continue
    const url = resolveHref(response.href, home)
    if (url === null || !isSameOrigin(url, settings.server)) {
      return fail(CalDavErrorCode.Malformed, 'the server sent an invalid subscription href')
    }
    subscriptions.push(subscriptionOf(response, url))
  }
  return ok(subscriptions)
}

/** The `?export` of a subscription: one request, the whole feed as the server holds it. */
async function exportOf(settings: Settings, calendarUrl: string): Promise<CalDavResult<string>> {
  const reply = await send(settings, 'GET', new URL('?export', calendarUrl), {
    Accept: 'text/calendar',
  })
  if (!reply.success) return reply
  if (reply.output.status !== 200) {
    return fail(
      CalDavErrorCode.Server,
      `the subscription's export answered ${reply.output.status}`,
    )
  }
  return ok(reply.output.text)
}

/** One exported calendar, parsed, or why it could not be. */
async function parsedExport(
  settings: Settings,
  calendarUrl: string,
): Promise<CalDavResult<IcalComponent>> {
  const exported = await exportOf(settings, calendarUrl)
  if (!exported.success) return exported
  const parsed = parseIcal(exported.output)
  if (!parsed.success) {
    return fail(
      CalDavErrorCode.Malformed,
      `the subscription's export is not iCalendar: ${parsed.error.message}`,
    )
  }
  return ok(parsed.output)
}

/**
 * The text of one virtual object: the calendar's own properties, its time zones (an event may
 * name a zone only its `VTIMEZONE` defines) and the component itself, untouched.
 */
function objectDoc(root: IcalComponent, component: IcalComponent): string {
  return serializeIcal({
    name: root.name,
    properties: [...root.properties],
    components: [
      ...root.components.filter((child) => child.name.toUpperCase() === 'VTIMEZONE'),
      component,
    ],
  })
}

/**
 * Whether `component` overlaps the range the caller asked for. Dates resolve as the engine
 * reads them elsewhere: through the export's own `VTIMEZONE`s when a value is in one, UTC
 * otherwise. A component whose dates cannot be read is kept: the engine reports it as
 * unreadable, and a filter must never silently drop an event.
 */
function overlaps(
  root: IcalComponent,
  component: IcalComponent,
  timeRange: { start?: Date; end?: Date },
): boolean {
  const instant = (name: string): Date | undefined => {
    const property = getProperty(component, name)
    const value = property && readDate(property)
    return value && resolveInstant(value, { root })
  }
  const start = instant('DTSTART')
  const end = instant('DTEND')
  if (start === undefined && end === undefined) return true
  if (timeRange.start && end !== undefined && end < timeRange.start) return false
  if (timeRange.end && start !== undefined && start > timeRange.end) return false
  return true
}

/** The events or tasks of a subscription, split from its export into virtual objects. */
async function listSubscribedObjects(
  settings: Settings,
  calendar: SubscribedCalendar,
  options: ListObjectsOptions,
): Promise<CalDavResult<CalDavObject[]>> {
  const root = await parsedExport(settings, calendar.url)
  if (!root.success) return root
  const component = options.component.toUpperCase()
  const objects: CalDavObject[] = []
  for (const child of root.output.components) {
    if (child.name.toUpperCase() !== component) continue
    // Without a UID there is no address to read the object back at, and `childUrl` refuses the
    // names that cannot name a member, so both are skipped instead of thrown.
    const uid = getProperty(child, 'UID')?.value
    if (!uid || uid === '.' || uid === '..') continue
    if (options.timeRange && !overlaps(root.output, child, options.timeRange)) continue
    objects.push({
      url: childUrl(calendar.url, `${uid}.ics`).href,
      etag: null,
      data: objectDoc(root.output, child),
    })
  }
  return ok(objects)
}

/** One virtual object of a subscription, found by the UID its address was built from. */
async function subscribedObject(
  settings: Settings,
  calendar: SubscribedCalendar,
  url: string,
): Promise<CalDavResult<CalDavObject>> {
  let uid: string
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
    uid = name.endsWith('.ics') ? name.slice(0, -4) : name
  } catch {
    return fail(CalDavErrorCode.InvalidArgument, `${url} is not a valid object address`)
  }
  const root = await parsedExport(settings, calendar.url)
  if (!root.success) return root
  const match = root.output.components.find((child) =>
    getProperty(child, 'UID')?.value === uid
  )
  if (!match) return fail(CalDavErrorCode.NotFound, `${url} is not in the subscription's export`)
  return ok({ url, etag: null, data: objectDoc(root.output, match) })
}

/**
 * Wrap `client` so the calendar subscriptions of the same server and user are listed and read.
 *
 * Only the client's own settings change: subscriptions are asked of the same origin, with the
 * same credentials. When the subscription listing itself fails, the library's list is returned
 * as it is: a server that will not answer the extra PROPFIND keeps its calendars readable,
 * with the subscriptions left out.
 */
export function withSubscriptions(
  client: CalDavClient,
  options: SubscriptionOptions,
): CalDavClient {
  const settings = settingsOf(options)
  // The subscriptions the last `listCalendars` saw; writes to them are refused.
  let subscriptions: SubscribedCalendar[] = []

  const subscribedAt = (url: string | URL): SubscribedCalendar | undefined =>
    subscriptions.find((calendar) => sameResource(calendar.url, url))
  const subscribedParentOf = (url: string | URL): SubscribedCalendar | undefined => {
    try {
      return subscribedAt(new URL('.', url))
    } catch {
      return undefined
    }
  }
  const refuse = <T>(calendar: SubscribedCalendar): CalDavResult<T> =>
    fail(
      CalDavErrorCode.InvalidArgument,
      `${calendar.displayName} is a calendar subscription, which is read-only; ` +
        "edit it in the server's calendar app instead",
    )

  return {
    discover: () => client.discover(),

    listCalendars: async (homeUrl) => {
      const base = await client.listCalendars(homeUrl)
      if (!base.success) return base
      let home: URL
      try {
        home = new URL(homeUrl)
      } catch {
        return fail(CalDavErrorCode.InvalidArgument, 'homeUrl is not a valid URL')
      }
      const found = await subscribedOf(settings, home)
      // The subscriptions of the last listing are the ones the writes below compare against.
      subscriptions = found.success ? found.output : []
      const extra = subscriptions.filter((calendar) =>
        !base.output.some((known) => sameResource(known.url, calendar.url))
      )
      return ok([...base.output, ...extra])
    },

    listObjects: async (calendarUrl, listOptions) => {
      const calendar = subscribedAt(calendarUrl)
      if (calendar) return listSubscribedObjects(settings, calendar, listOptions)
      return client.listObjects(calendarUrl, listOptions)
    },

    getObjects: (calendarUrl, urls) => client.getObjects(calendarUrl, urls),

    getObject: async (url) => {
      const calendar = subscribedParentOf(url)
      if (calendar) return subscribedObject(settings, calendar, `${url}`)
      return client.getObject(url)
    },

    createObject: async (calendarUrl, ics, createOptions) => {
      const calendar = subscribedAt(calendarUrl)
      if (calendar) return refuse(calendar)
      return client.createObject(calendarUrl, ics, createOptions)
    },

    updateObject: async (url, ics, etag) => {
      const calendar = subscribedParentOf(url)
      if (calendar) return refuse(calendar)
      return client.updateObject(url, ics, etag)
    },

    deleteObject: async (url, etag) => {
      const calendar = subscribedParentOf(url)
      if (calendar) return refuse(calendar)
      return client.deleteObject(url, etag)
    },

    makeCalendar: (homeUrl, calendar) => client.makeCalendar(homeUrl, calendar),

    updateCalendar: (url, changes) => client.updateCalendar(url, changes),

    deleteCalendar: async (url) => {
      const calendar = subscribedAt(url)
      if (calendar) return refuse(calendar)
      return client.deleteCalendar(url)
    },

    getPrivileges: client.getPrivileges ? (url) => client.getPrivileges!(url) : undefined,
  }
}
