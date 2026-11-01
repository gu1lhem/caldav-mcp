// ── Event tools: query_events, get_event, create_event, update_event, delete_event ──

import { AlarmRelated, type EventPatch } from '@spy4x/time/ical-tasks'
import type { ToolRegistry } from './index.ts'
import { DEFAULT_LIMIT, MAX_LIMIT, type QueryEngine } from '../caldav/query.ts'
import {
  alarmsSchema,
  type Args,
  dateSchema,
  nullableAlarms,
  nullableDate,
  nullableString,
  nullableStringList,
  optionalInstant,
  optionalInteger,
  optionalString,
  reply,
  requiredString,
} from './args.ts'

const ETAG_NOTE = 'exactly as query_events or get_event returned it, quotes included'

function eventFields(nullable: boolean) {
  const t = (type: string) => (nullable ? [type, 'null'] : type)
  const clear = nullable ? '; null clears it' : ''
  return {
    summary: { type: 'string', description: 'Title' },
    description: { type: t('string'), description: `Notes${clear}` },
    location: { type: t('string'), description: `Location${clear}` },
    start: dateSchema('Start'),
    end: dateSchema('End', nullable),
    categories: { type: t('array'), items: { type: 'string' }, description: `Tags${clear}` },
    alarms: alarmsSchema('start', nullable),
    rrule: { type: t('string'), description: `Repeat rule, such as FREQ=WEEKLY;BYDAY=TU${clear}` },
  }
}

function readPatch(args: Args): EventPatch {
  const patch: EventPatch = {
    summary: nullableString(args, 'summary'),
    description: nullableString(args, 'description'),
    location: nullableString(args, 'location'),
    start: nullableDate(args, 'start'),
    end: nullableDate(args, 'end'),
    categories: nullableStringList(args, 'categories'),
    rrule: nullableString(args, 'rrule'),
    alarms: nullableAlarms(args, 'alarms', AlarmRelated.Start),
  }
  if (patch.summary === null) throw new Error('summary cannot be cleared')
  if (patch.start === null) throw new Error('start cannot be cleared')
  for (const key of Object.keys(patch) as (keyof EventPatch)[]) {
    if (patch[key] === undefined) delete patch[key]
  }
  return patch
}

export function registerEventTools(mcp: ToolRegistry, engine: QueryEngine): void {
  mcp.registerTool(
    {
      name: 'query_events',
      description: 'Search events across all calendars. Returns counts and a compact list ' +
        'sorted by start.',
      inputSchema: {
        type: 'object',
        properties: {
          calendarUrl: { type: 'string', description: 'Only this calendar (from list_calendars)' },
          list: {
            type: 'string',
            description: 'Only the calendars of this named list (from list_lists); exclusive ' +
              'with calendarUrl',
          },
          dateFrom: dateSchema('Only events that end after this'),
          dateTo: dateSchema('Only events that start before this'),
          text: { type: 'string', description: 'Text in summary, description or location' },
          limit: {
            type: 'integer',
            description: `Most events listed (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
          },
        },
      },
    },
    async (args) =>
      reply(
        await engine.queryEvents({
          calendarUrl: optionalString(args, 'calendarUrl'),
          list: optionalString(args, 'list'),
          from: optionalInstant(args, 'dateFrom', engine.zone),
          to: optionalInstant(args, 'dateTo', engine.zone),
          text: optionalString(args, 'text'),
          limit: optionalInteger(args, 'limit', 1, MAX_LIMIT),
        }),
      ),
  )

  mcp.registerTool(
    {
      name: 'get_event',
      description: 'Get one event by URL with every field and the etag to edit it with',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Event URL from query_events' } },
        required: ['url'],
      },
    },
    async (args) => reply(await engine.getEvent(requiredString(args, 'url'))),
  )

  mcp.registerTool(
    {
      name: 'create_event',
      description: 'Create an event in a calendar. Returns its url, uid and etag.',
      inputSchema: {
        type: 'object',
        properties: {
          calendarUrl: { type: 'string', description: 'Calendar URL from list_calendars' },
          uid: { type: 'string', description: 'UID to give the event; default: a new UUID' },
          ...eventFields(false),
        },
        required: ['calendarUrl', 'summary', 'start', 'end'],
      },
    },
    async (args) => {
      const calendarUrl = requiredString(args, 'calendarUrl')
      requiredString(args, 'summary')
      requiredString(args, 'start')
      requiredString(args, 'end')
      return reply(
        await engine.createEvent(calendarUrl, readPatch(args), optionalString(args, 'uid')),
      )
    },
  )

  mcp.registerTool(
    {
      name: 'update_event',
      description:
        'Change an event. Only the fields you pass change; guests, reminders (unless you ' +
        'pass alarms), repeat rules, time zones and exceptions are kept. Pass null to clear a ' +
        'field. Fails with code Conflict when the event changed since you read it.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Event URL' },
          etag: { type: 'string', description: `Current etag, ${ETAG_NOTE}` },
          ...eventFields(true),
        },
        required: ['url', 'etag'],
      },
    },
    async (args) =>
      reply(
        await engine.updateEvent(
          requiredString(args, 'url'),
          requiredString(args, 'etag'),
          readPatch(args),
        ),
      ),
  )

  mcp.registerTool(
    {
      name: 'delete_event',
      description: 'Delete an event if it has not changed since you read it',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Event URL' },
          etag: { type: 'string', description: `Current etag, ${ETAG_NOTE}` },
        },
        required: ['url', 'etag'],
      },
    },
    async (args) => {
      const url = requiredString(args, 'url')
      const deleted = reply(await engine.deleteObject(url, requiredString(args, 'etag')))
      return deleted === null ? { success: true, url } : deleted
    },
  )
}
