import { describe, expect, it } from 'vitest'
import { parseLine, pendingKey, toolError, parseError } from '../../../src/adapters/mcp/jsonrpc.js'

describe('parseLine', () => {
  it('parses a request', () => {
    const message = parseLine('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}')
    expect(message.type).toBe('request')
    if (message.type !== 'request') return
    expect(message.id).toBe(1)
    expect(message.method).toBe('tools/call')
  })

  it('parses a notification', () => {
    const message = parseLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    expect(message.type).toBe('notification')
  })

  it('parses a response', () => {
    const message = parseLine('{"jsonrpc":"2.0","id":"abc","result":{"tools":[]}}')
    expect(message.type).toBe('response')
    if (message.type !== 'response') return
    expect(message.id).toBe('abc')
  })

  it('throws on a line that is not JSON', () => {
    expect(() => parseLine('this is {not json')).toThrow()
  })

  it('throws on JSON that is not a message', () => {
    // A bare array or a bare string is valid JSON and still not JSON-RPC:
    // treating it as a message would misroute whatever came with it.
    expect(() => parseLine('[1,2,3]')).toThrow()
    expect(() => parseLine('"hello"')).toThrow()
    expect(() => parseLine('{"jsonrpc":"2.0"}')).toThrow()
  })
})

describe('pendingKey', () => {
  it('keeps a string id apart from a numeric one', () => {
    // JSON-RPC allows both spellings, and matching "1" to 1 would deliver a
    // response to the wrong waiter — for a gateway that is a routing error,
    // not a type nicety.
    expect(pendingKey('1')).not.toBe(pendingKey(1))
  })
})

describe('toolError', () => {
  it('builds a CallToolResult with isError', () => {
    const refusal = toolError(5, 'no') as {
      id: number
      result: { isError: boolean; content: Array<{ type: string; text: string }> }
    }
    expect(refusal.id).toBe(5)
    expect(refusal.result.isError).toBe(true)
    expect(refusal.result.content[0]!.text).toContain('no')
  })
})

describe('parseError', () => {
  it('answers with id null and code -32700', () => {
    const error = parseError('broken') as { id: null; error: { code: number } }
    expect(error.id).toBeNull()
    expect(error.error.code).toBe(-32700)
  })
})
