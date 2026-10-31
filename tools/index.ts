// ── Tool definitions and registration ──

import type { McpHandler } from '../mcp.ts'
import type { QueryEngine } from '../caldav/query.ts'
import { registerCalendarTools } from './calendars.ts'
import { registerTodoTools } from './todos.ts'
import { registerEventTools } from './events.ts'
import { registerListTools } from './lists.ts'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

/** Where a tool module registers its tools: the MCP handler, or a filter in front of it. */
export type ToolRegistry = Pick<McpHandler, 'registerTool'>

/**
 * Which tools the server offers, set by `CALDAV_MCP_TOOLS`. `all` offers every tool, `no-delete`
 * leaves out every `delete_*` tool, and `read-only` offers only the tools that change nothing.
 */
export const TOOL_MODES = ['all', 'no-delete', 'read-only'] as const
export type ToolMode = typeof TOOL_MODES[number]

/**
 * The tools `read-only` keeps. An allowlist, not a list of write tools, so a tool added later is
 * left out of `read-only` until someone adds it here.
 */
const READ_TOOLS = new Set([
  'list_calendars',
  'list_lists',
  'query_events',
  'get_event',
  'query_todos',
  'get_todo',
])

/** Whether `mode` offers the tool called `name`. */
export function isToolOffered(name: string, mode: ToolMode): boolean {
  switch (mode) {
    case 'all':
      return true
    case 'no-delete':
      return !name.startsWith('delete_')
    case 'read-only':
      return READ_TOOLS.has(name)
  }
}

/**
 * Register the tools `mode` offers. A tool it leaves out is never registered, so `tools/list`
 * does not show it and `tools/call` answers it as an unknown tool.
 */
export function registerAllTools(mcp: McpHandler, engine: QueryEngine, mode: ToolMode): void {
  const registry: ToolRegistry = {
    registerTool: (definition, handler) => {
      if (isToolOffered(definition.name, mode)) mcp.registerTool(definition, handler)
    },
  }
  registerCalendarTools(registry, engine)
  registerTodoTools(registry, engine)
  registerEventTools(registry, engine)
  registerListTools(registry, engine)
}
