// ── Calendar tools: list_calendars, make_calendar, delete_calendar ──

import type { ToolRegistry } from './index.ts'
import type { QueryEngine } from '../caldav/query.ts'
import { optionalString, reply, requiredString } from './args.ts'

const COMPONENTS = ['VEVENT', 'VTODO', 'VJOURNAL']

export function registerCalendarTools(mcp: ToolRegistry, engine: QueryEngine): void {
  mcp.registerTool(
    {
      name: 'list_calendars',
      description:
        'List the calendars with the components they hold (empty means any), colors and ctags. ' +
        'A calendar marked subscribed is a read-only subscription to an external feed',
      inputSchema: { type: 'object', properties: {} },
    },
    async () => reply(await engine.listCalendars()),
  )

  mcp.registerTool(
    {
      name: 'delete_calendar',
      description: 'Delete a calendar and every event and task in it. Only a URL that ' +
        'list_calendars returns is accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Calendar URL from list_calendars' },
        },
        required: ['url'],
      },
    },
    async (args) => {
      const deleted = reply(await engine.deleteCalendar(requiredString(args, 'url')))
      return 'error' in deleted ? deleted : { success: true, url: deleted.url }
    },
  )

  mcp.registerTool(
    {
      name: 'make_calendar',
      description: "Create a calendar in the user's calendar home. Returns its url.",
      inputSchema: {
        type: 'object',
        properties: {
          displayName: { type: 'string', description: 'Calendar display name' },
          components: {
            type: 'array',
            items: { type: 'string', enum: COMPONENTS },
            description: 'Component types it holds (default: VEVENT, VTODO)',
          },
          color: { type: 'string', description: 'Color, such as #FF542B' },
        },
        required: ['displayName'],
      },
    },
    async (args) => {
      const components = args['components'] ?? ['VEVENT', 'VTODO']
      if (
        !Array.isArray(components) || components.length === 0 ||
        !components.every((c) => COMPONENTS.includes(c))
      ) {
        throw new Error(`components must be a non-empty array of ${COMPONENTS.join(', ')}`)
      }
      const made = reply(
        await engine.makeCalendar(
          requiredString(args, 'displayName'),
          components,
          optionalString(args, 'color'),
        ),
      )
      return 'error' in made ? made : { success: true, ...made }
    },
  )
}
