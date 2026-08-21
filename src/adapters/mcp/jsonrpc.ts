/**
 * JSON-RPC 2.0 over newline-delimited JSON — the framing MCP uses over stdio.
 *
 * Written by hand rather than taken from the SDK: the repository carries two
 * runtime dependencies and every new one is code inside a security boundary
 * that nobody here has read. The framing itself is forty lines; the decisions
 * are all in the gateway, and they go through the core's facade like in every
 * other adapter.
 */

export type JsonRpcId = string | number

export type Message =
  | { type: 'request'; id: JsonRpcId; method: string; params: unknown; value: Record<string, unknown> }
  | { type: 'notification'; method: string; params: unknown; value: Record<string, unknown> }
  | { type: 'response'; id: JsonRpcId | null; value: Record<string, unknown> }

/**
 * Parses one line into a classified message. Throws on anything that is not
 * JSON-RPC: the caller decides what loud means for its direction (a parse
 * error back to the host, a dead gateway towards the upstream), and this
 * function does not pre-empt that decision by guessing.
 *
 * The parsed object is kept as `value`: an intercepted response is
 * reserialized from it after the cleaned text is written in, and reserializing
 * from a stripped-down type would lose the fields we never looked at.
 */
export function parseLine(line: string): Message {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON-RPC message')
  }
  const value = parsed as Record<string, unknown>

  const method = value['method']
  if (typeof method === 'string' && method !== '') {
    const id = value['id']
    if (typeof id === 'string' || typeof id === 'number') {
      return { type: 'request', id, method, params: value['params'], value }
    }
    // A method without an id is a notification. A null id rides along here
    // too: the spec discourages it and nothing in MCP uses it, and answering
    // a null id is worse than treating the message as fire-and-forget.
    return { type: 'notification', method, params: value['params'], value }
  }

  if (Object.hasOwn(value, 'id') && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))) {
    const id = value['id']
    if (typeof id === 'string' || typeof id === 'number' || id === null) {
      return { type: 'response', id, value }
    }
  }

  throw new Error('not a JSON-RPC message')
}

/**
 * The key a pending request is remembered under.
 *
 * The type rides in the key: JSON-RPC allows both spellings of the same id,
 * and matching "1" to 1 would deliver an intercepted response to the wrong
 * waiter. For a proxy that is a routing error, not a type nicety.
 */
export function pendingKey(id: JsonRpcId | null): string {
  return `${typeof id}:${String(id)}`
}

/**
 * A refusal in the shape of a tool's answer.
 *
 * There is no "deny the call" message in MCP: the protocol's way to say no to
 * a tools/call is a CallToolResult with isError set. The model reads the
 * reason as the tool's output — which is exactly what a refusal needs: the
 * call did not happen, and the model says so instead of inventing a result.
 */
export function toolError(id: JsonRpcId | null, text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError: true },
  }
}

/** The protocol's own answer to a line that could not be parsed. */
export function parseError(message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message } }
}
