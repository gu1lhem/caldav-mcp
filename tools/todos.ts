// ── Todo tools: query_todos, get_todo, create_todo, update_todo, delete_todo ──

import { AlarmRelated } from '@spy4x/time/ical-tasks';
import type { ToolRegistry } from './index.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, type QueryEngine, type TodoChange } from '../caldav/query.ts';
import {
  alarmsSchema,
  type Args,
  dateSchema,
  nullableAlarms,
  nullableDate,
  nullableInteger,
  nullableString,
  nullableStringList,
  optionalBoolean,
  optionalInstant,
  optionalInteger,
  optionalString,
  reply,
  requiredString,
  TODO_STATUS_ENUM,
  todoStatus,
} from './args.ts';

const ETAG_NOTE = 'exactly as query_todos or get_todo returned it, quotes included';

/** Schema of the fields create_todo and update_todo share; `nullable` lets update clear them. */
function todoFields(nullable: boolean) {
  const t = (type: string) => (nullable ? [type, 'null'] : type);
  const clear = nullable ? '; null clears it' : '';
  return {
    summary: { type: 'string', description: 'Title' },
    description: { type: t('string'), description: `Notes, any length${clear}` },
    categories: {
      type: t('array'),
      items: { type: 'string' },
      description: `Tags; replaces the whole list${clear}`,
    },
    due: dateSchema('Due date', nullable),
    start: dateSchema('Start date (DTSTART)', nullable),
    alarms: alarmsSchema('due', nullable),
    priority: { type: t('integer'), description: `1 (highest) to 9 (lowest)${clear}` },
    status: {
      type: t('string'),
      enum: nullable ? [...TODO_STATUS_ENUM, null] : TODO_STATUS_ENUM,
      description: 'COMPLETED completes the task like Tasks.org: a repeating task moves to its ' +
        'next due date and stays open. NEEDS-ACTION on a completed task reopens it.',
    },
    percentComplete: { type: t('integer'), description: `0 to 100${clear}` },
    parent: {
      type: t('string'),
      description: `UID of the parent task (its \`uid\` from get_todo)${clear}`,
    },
    rrule: {
      type: t('string'),
      description: `Repeat rule, such as FREQ=WEEKLY;BYDAY=MO${
        nullable ? '; null ends the series' : ''
      }`,
    },
    sortOrder: {
      type: t('integer'),
      description: `Manual order (X-APPLE-SORT-ORDER) that Tasks.org sorts by${clear}`,
    },
  };
}

function readChange(args: Args): TodoChange {
  const change: TodoChange = {
    summary: nullableString(args, 'summary'),
    description: nullableString(args, 'description'),
    categories: nullableStringList(args, 'categories'),
    due: nullableDate(args, 'due'),
    start: nullableDate(args, 'start'),
    priority: nullableInteger(args, 'priority', 0, 9),
    status: todoStatus(args, 'status'),
    percentComplete: nullableInteger(args, 'percentComplete', 0, 100),
    parent: nullableString(args, 'parent'),
    rrule: nullableString(args, 'rrule'),
    sortOrder: nullableInteger(args, 'sortOrder', -(2 ** 31), 2 ** 31 - 1),
    alarms: nullableAlarms(args, 'alarms', AlarmRelated.End),
  };
  if (change.summary === null) throw new Error('summary cannot be cleared');
  for (const key of Object.keys(change) as (keyof TodoChange)[]) {
    if (change[key] === undefined) delete change[key];
  }
  return change;
}

export function registerTodoTools(mcp: ToolRegistry, engine: QueryEngine): void {
  mcp.registerTool(
    {
      name: 'query_todos',
      description: 'Search tasks across all calendars. Returns counts and a compact list ' +
        '(url, etag, summary, status, due, priority) sorted by due date; open tasks only unless ' +
        'status is COMPLETED or includeCompleted is true. Set detail for full fields.',
      inputSchema: {
        type: 'object',
        properties: {
          calendarUrl: { type: 'string', description: 'Only this calendar (from list_calendars)' },
          status: { type: 'string', enum: TODO_STATUS_ENUM, description: 'Only this status' },
          text: { type: 'string', description: 'Case-insensitive text in summary or description' },
          dueBefore: dateSchema('Only tasks due before this'),
          priority: {
            type: 'object',
            properties: {
              min: { type: 'integer', description: 'Min priority (1=highest, 9=lowest)' },
              max: { type: 'integer', description: 'Max priority' },
            },
            description: 'Priority range; tasks without a priority are left out',
          },
          includeCompleted: { type: 'boolean', description: 'Also list completed tasks' },
          detail: {
            type: 'boolean',
            description: 'Full fields (description, categories, parent, rrule, reminders, …)',
          },
          limit: {
            type: 'integer',
            description: `Most tasks listed (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
          },
        },
      },
    },
    async (args) => {
      const priority = args['priority'];
      if (priority !== undefined && (typeof priority !== 'object' || priority === null)) {
        throw new Error('priority must be an object with min and max');
      }
      const range = priority as Args | undefined;
      return reply(
        await engine.queryTodos({
          calendarUrl: optionalString(args, 'calendarUrl'),
          status: todoStatus(args, 'status') ?? undefined,
          text: optionalString(args, 'text'),
          dueBefore: optionalInstant(args, 'dueBefore', engine.zone),
          priority: range
            ? { min: optionalInteger(range, 'min', 1, 9), max: optionalInteger(range, 'max', 1, 9) }
            : undefined,
          includeCompleted: optionalBoolean(args, 'includeCompleted'),
          detail: optionalBoolean(args, 'detail'),
          limit: optionalInteger(args, 'limit', 1, MAX_LIMIT),
        }),
      );
    },
  );

  mcp.registerTool(
    {
      name: 'get_todo',
      description: 'Get one task by URL with every field, its uid and the etag to edit it with',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Task URL from query_todos' } },
        required: ['url'],
      },
    },
    async (args) => reply(await engine.getTodo(requiredString(args, 'url'))),
  );

  mcp.registerTool(
    {
      name: 'create_todo',
      description: 'Create a task in a calendar. Returns its url, uid and etag.',
      inputSchema: {
        type: 'object',
        properties: {
          calendarUrl: { type: 'string', description: 'Calendar URL from list_calendars' },
          uid: { type: 'string', description: 'UID to give the task; default: a new UUID' },
          ...todoFields(false),
        },
        required: ['calendarUrl', 'summary'],
      },
    },
    async (args) => {
      const calendarUrl = requiredString(args, 'calendarUrl');
      requiredString(args, 'summary');
      return reply(
        await engine.createTodo(calendarUrl, readChange(args), optionalString(args, 'uid')),
      );
    },
  );

  mcp.registerTool(
    {
      name: 'update_todo',
      description:
        'Change a task. Only the fields you pass change; reminders (unless you pass alarms), ' +
        'repeat rules, links and fields this tool does not know are kept. Pass null to clear a ' +
        'field. ' +
        'Fails with code Conflict when the task changed since you read it.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Task URL' },
          etag: { type: 'string', description: `Current etag, ${ETAG_NOTE}` },
          ...todoFields(true),
        },
        required: ['url', 'etag'],
      },
    },
    async (args) =>
      reply(
        await engine.updateTodo(
          requiredString(args, 'url'),
          requiredString(args, 'etag'),
          readChange(args),
        ),
      ),
  );

  mcp.registerTool(
    {
      name: 'delete_todo',
      description: 'Delete a task if it has not changed since you read it',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Task URL' },
          etag: { type: 'string', description: `Current etag, ${ETAG_NOTE}` },
        },
        required: ['url', 'etag'],
      },
    },
    async (args) => {
      const url = requiredString(args, 'url');
      const deleted = reply(await engine.deleteObject(url, requiredString(args, 'etag')));
      return deleted === null ? { success: true, url } : deleted;
    },
  );
}
