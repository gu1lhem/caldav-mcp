// ── Tool argument readers ──
// Each throws an `Error` naming the argument when the model sent the wrong type, which the MCP
// handler turns into an `isError` result. `null` means "clear this field" where a reader allows it.

import { IcalDateKind, type IcalDateValue } from '@spy4x/time/ical';
import {
  type AlarmInput,
  type AlarmRelated,
  AlarmTriggerKind,
  TodoStatus,
} from '@spy4x/time/ical-tasks';
import { parseDateArg, startInstant } from '../caldav/dates.ts';
import type { EngineResult } from '../caldav/types.ts';

export type Args = Record<string, unknown>;

const TODO_STATUSES: Record<string, TodoStatus> = {
  'NEEDS-ACTION': TodoStatus.NeedsAction,
  'IN-PROCESS': TodoStatus.InProcess,
  'COMPLETED': TodoStatus.Completed,
  'CANCELLED': TodoStatus.Cancelled,
};

export const TODO_STATUS_ENUM = Object.keys(TODO_STATUSES);

/** JSON Schema of a date argument; `nullable` adds `null` to clear it. */
export function dateSchema(description: string, nullable = false) {
  return {
    type: nullable ? ['string', 'null'] : 'string',
    description: `${description}. \`YYYY-MM-DD\` for a whole day, \`YYYY-MM-DDTHH:MM:SSZ\` or ` +
      `with an offset (\`+07:00\`) for a moment, \`YYYY-MM-DDTHH:MM:SS[Area/City]\` to keep a ` +
      `time zone the task already uses${nullable ? '; null clears it' : ''}.`,
  };
}

function bad(name: string, what: string): never {
  throw new Error(`${name} must be ${what}`);
}

export function requiredString(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') bad(name, 'a non-empty string');
  return value;
}

export function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') bad(name, 'a string');
  return value;
}

/** `undefined` leaves the field alone, `null` clears it. */
export function nullableString(args: Args, name: string): string | null | undefined {
  const value = args[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') bad(name, 'a string or null');
  return value;
}

export function nullableInteger(
  args: Args,
  name: string,
  min: number,
  max: number,
): number | null | undefined {
  const value = args[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    bad(name, `an integer from ${min} to ${max}, or null`);
  }
  return value;
}

export function optionalInteger(args: Args, name: string, min: number, max: number) {
  const value = nullableInteger(args, name, min, max);
  return value ?? undefined;
}

export function optionalBoolean(args: Args, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') bad(name, 'true or false');
  return value;
}

export function nullableStringList(args: Args, name: string): string[] | null | undefined {
  const value = args[name];
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    bad(name, 'an array of strings, or null');
  }
  return value as string[];
}

export function nullableDate(args: Args, name: string): IcalDateValue | null | undefined {
  const value = args[name];
  if (value === undefined || value === null) return value;
  const parsed = typeof value === 'string' ? parseDateArg(value) : undefined;
  if (!parsed) bad(name, 'a date like 2026-10-12, 2026-10-12T09:00:00Z or null');
  return parsed;
}

/** A filter bound as an instant; whole days and floating times are read in `zone`. */
export function optionalInstant(args: Args, name: string, zone: string): Date | undefined {
  const value = nullableDate(args, name);
  if (!value) return undefined;
  const instant = startInstant(value, zone);
  if (!instant) bad(name, 'a date in a known time zone');
  return instant;
}

export function todoStatus(args: Args, name: string): TodoStatus | null | undefined {
  const value = args[name];
  if (value === undefined || value === null) return value;
  const status = typeof value === 'string' ? TODO_STATUSES[value.toUpperCase()] : undefined;
  if (!status) bad(name, `one of ${TODO_STATUS_ENUM.join(', ')}`);
  return status;
}

/** The engine's output, or `{ error, code }` that the MCP handler marks `isError`. */
export function reply<T>(result: EngineResult<T>): T | { error: string; code: string } {
  return result.success ? result.output : { error: result.error.message, code: result.error.code };
}

/** An RFC 5545 duration without a sign: `PT1H`, `P1D`, `PT30M`, `P2W`, `PT0S`. */
const DURATION = /^P(?!$)(?:\d+W|(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;

/**
 * JSON Schema of the `alarms` argument. `from` names what `before` counts from, so the model
 * knows: a task counts from its due time, an event from its start.
 */
export function alarmsSchema(from: 'due' | 'start', nullable: boolean) {
  return {
    type: nullable ? ['array', 'null'] : 'array',
    items: {
      type: 'object',
      properties: {
        before: {
          type: 'string',
          description: `How long before the ${from} to remind, as an ISO 8601 duration: PT15M, ` +
            `PT1H, P1D, PT0S (at the ${from} itself). Needs a ${from} date on the ` +
            `${from === 'due' ? 'task' : 'event'}. Give this or at; no sign.`,
        },
        at: {
          type: 'string',
          description: 'A fixed moment to remind at, in UTC: 2026-10-12T08:00:00Z. Give this ' +
            'or before.',
        },
      },
    },
    description: `Reminders. The list replaces every existing reminder; each is { before } or ` +
      `{ at }. Leaving it out keeps the existing ones${nullable ? '; null removes them all' : ''}.`,
  };
}

/**
 * Read the `alarms` argument into library reminders. `undefined` keeps the existing ones, `null`
 * removes them. `before` counts from the due time of a task (`related` End, as Tasks.org shows it)
 * or the start of an event (Start).
 */
export function nullableAlarms(
  args: Args,
  name: string,
  related: AlarmRelated,
): AlarmInput[] | null | undefined {
  const value = args[name];
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value)) bad(name, 'a list of { before } or { at } objects, or null');
  return value.map((entry: unknown, index): AlarmInput => {
    const where = `${name}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      bad(where, 'an object with before or at');
    }
    const { before, at, ...extra } = entry as Args;
    const unknown = Object.keys(extra);
    if (unknown.length > 0) bad(where, `only before or at, not ${unknown.join(', ')}`);
    if ((before === undefined) === (at === undefined)) bad(where, 'exactly one of before or at');
    if (before !== undefined) {
      const duration = typeof before === 'string' ? before.trim().toUpperCase() : '';
      if (!DURATION.test(duration)) {
        bad(`${where}.before`, 'a duration like PT15M, PT1H, P1D or PT0S');
      }
      // A zero offset is written without a sign, as Tasks.org writes it.
      const sign = /^P(?:T?0+[A-Z])+$/.test(duration) ? '' : '-';
      return {
        trigger: { kind: AlarmTriggerKind.Relative, duration: `${sign}${duration}`, related },
      };
    }
    const moment = typeof at === 'string' ? parseDateArg(at) : undefined;
    if (moment?.kind !== IcalDateKind.Utc) {
      bad(`${where}.at`, 'a UTC time like 2026-10-12T08:00:00Z');
    }
    return { trigger: { kind: AlarmTriggerKind.Absolute, at: moment } };
  });
}
