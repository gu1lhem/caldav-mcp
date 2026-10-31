// ── List tools: list_lists ──

import type { ToolRegistry } from './index.ts'
import type { QueryEngine } from '../caldav/query.ts'
import { reply } from './args.ts'

export function registerListTools(mcp: ToolRegistry, engine: QueryEngine): void {
  mcp.registerTool(
    {
      name: 'list_lists',
      description: 'List the named calendar lists the owner made with the caldav-mcp lists ' +
        'command, with their member calendars. The built-in list "all" covers every calendar ' +
        'of the account, always current. A null displayName marks a calendar that no longer ' +
        'exists.',
      inputSchema: { type: 'object', properties: {} },
    },
    async () => reply(await engine.listLists()),
  )
}
