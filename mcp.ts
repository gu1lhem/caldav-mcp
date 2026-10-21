// ── MCP Protocol Handler ──
// JSON-RPC 2.0 over stdio or HTTP.
// Handles lifecycle: initialize → tools/list → tools/call → shutdown

import type { ToolDefinition, ToolHandler } from './tools/index.ts'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  /** Absent on a notification, which never gets a response. */
  id?: string | number
  /** Absent on a client's response to a server request. */
  method?: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type Transport = 'stdio' | 'http'

export interface McpServerInfo {
  name: string
  version: string
}

/** Protocol versions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Most messages one batch may hold; a larger batch is refused whole, before any is run. */
export const MAX_BATCH_SIZE = 20

export class McpHandler {
  private tools: Map<string, { definition: ToolDefinition; handler: ToolHandler }>
  private initialized = false
  private serverInfo: McpServerInfo

  constructor(serverInfo: McpServerInfo) {
    this.serverInfo = serverInfo
    this.tools = new Map()
  }

  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler })
  }

  /**
   * Process one JSON-RPC message. Returns `null` for a notification (no `id`), which per
   * JSON-RPC 2.0 must never be answered, not even with an error.
   */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // A client's answer to a server request: this server sends none, so there is nothing to do.
    if (req.method === undefined && ('result' in req || 'error' in req)) return null
    const isNotification = req.id === undefined
    const id = req.id ?? null
    if (typeof req.method !== 'string' || (!isNotification && !isValidId(req.id))) {
      return isNotification ? null : error(null, -32600, 'Invalid Request')
    }
    if (isNotification) {
      if (req.method === 'notifications/initialized') this.initialized = true
      return null
    }

    const params = req.params ?? {}
    try {
      switch (req.method) {
        case 'initialize': {
          const requested = params.protocolVersion
          const protocolVersion = typeof requested === 'string' &&
              SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0]
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: this.serverInfo,
            },
          }
        }

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} }

        case 'tools/list': {
          const toolList = Array.from(this.tools.values()).map((t) => t.definition)
          return { jsonrpc: '2.0', id, result: { tools: toolList } }
        }

        case 'tools/call': {
          const { name, arguments: args } = params as {
            name?: unknown
            arguments?: Record<string, unknown>
          }
          if (typeof name !== 'string' || !name) {
            return error(id, -32602, 'Missing tool name')
          }
          const tool = this.tools.get(name)
          if (!tool) {
            return error(id, -32602, `Unknown tool: ${name}`)
          }
          return { jsonrpc: '2.0', id, result: await callTool(tool.handler, args ?? {}) }
        }

        default:
          return error(id, -32601, `Method not found: ${req.method}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return error(id, -32603, `Internal error: ${msg}`)
    }
  }

  /**
   * Parse and process one JSON-RPC message string: a single message or a batch (an array), which
   * protocol 2025-03-26 allows. Returns `null` when nothing is to be sent: a notification, or a
   * batch of notifications only. A batch gets an array with one response per request in it.
   */
  async handleMessage(message: string): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let req: unknown
    try {
      req = JSON.parse(message)
    } catch {
      return error(null, -32700, 'Parse error')
    }
    if (!Array.isArray(req)) return await this.handleOne(req)
    if (req.length === 0 || req.length > MAX_BATCH_SIZE) {
      return error(null, -32600, 'Invalid Request')
    }
    const responses: JsonRpcResponse[] = []
    for (const item of req) {
      const response = await this.handleOne(item)
      if (response) responses.push(response)
    }
    return responses.length > 0 ? responses : null
  }

  private async handleOne(req: unknown): Promise<JsonRpcResponse | null> {
    if (typeof req !== 'object' || req === null || Array.isArray(req)) {
      return error(null, -32600, 'Invalid Request')
    }
    return await this.handleRequest(req as JsonRpcRequest)
  }

  /** True once the client has sent `notifications/initialized`. */
  isInitialized(): boolean {
    return this.initialized
  }
}

/**
 * Run a tool and shape its outcome as an MCP tool result. A thrown error or a returned
 * `{ error: string }` becomes `isError: true`, so the model sees the failure instead of the
 * client treating it as a protocol fault or a success.
 */
async function callTool(
  handler: ToolHandler,
  args: Record<string, unknown>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  try {
    const result = await handler(args)
    const text = JSON.stringify(result) ?? 'null'
    return isErrorResult(result)
      ? { content: [{ type: 'text', text }], isError: true }
      : { content: [{ type: 'text', text }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: msg }], isError: true }
  }
}

function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null &&
    typeof (result as { error?: unknown }).error === 'string'
}

function isValidId(id: unknown): id is string | number {
  return typeof id === 'string' || typeof id === 'number'
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
