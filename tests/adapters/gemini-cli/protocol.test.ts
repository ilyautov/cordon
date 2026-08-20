import { describe, expect, it } from 'vitest'
import { parseEvent } from '../../../src/adapters/gemini-cli/protocol.js'

describe('parsing Gemini CLI events', () => {
  it('parses a user message', () => {
    const event = parseEvent(
      JSON.stringify({ session_id: 's', hook_event_name: 'BeforeAgent', prompt: 'work out the revenue' }),
    )
    expect(event).toEqual({ kind: 'BeforeAgent', sessionId: 's', prompt: 'work out the revenue' })
  })

  it('parses a tool call', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'ls' },
      }),
    )
    expect(event).toEqual({
      kind: 'BeforeTool',
      sessionId: 's',
      call: { tool: 'run_shell_command', args: { command: 'ls' } },
    })
  })

  it('parses a tool result', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'AfterTool',
        tool_name: 'web_fetch',
        tool_input: { url: 'https://example.org/' },
        tool_response: { llmContent: 'the page text', returnDisplay: 'the text', error: null },
      }),
    )
    expect(event.kind).toBe('AfterTool')
    expect(event.kind === 'AfterTool' && event.content).toBe('the page text')
    expect(event.kind === 'AfterTool' && event.unreadable).toBe(false)
  })

  it('sees the MCP server name when the call came from there', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'BeforeTool',
        tool_name: 'wb_update_price',
        tool_input: { nmId: 1 },
        mcp_context: { server_name: 'wildberries', tool_name: 'wb_update_price' },
      }),
    )
    expect(event.kind === 'BeforeTool' && event.mcpServer).toBe('wildberries')
  })

  it('parses the end of a turn', () => {
    const event = parseEvent(
      JSON.stringify({ session_id: 's', hook_event_name: 'AfterAgent', response: 'the final answer' }),
    )
    expect(event).toEqual({ kind: 'AfterAgent', sessionId: 's', response: 'the final answer' })
  })

  it('an unfamiliar event is ignored rather than breaking', () => {
    const event = parseEvent(JSON.stringify({ session_id: 's', hook_event_name: 'BeforeModel' }))
    expect(event.kind).toBe('ignored')
  })

  it('input that is not JSON is a refusal to parse', () => {
    expect(parseEvent('not json').kind).toBe('unparsable')
  })

  it('a call without a tool name is a refusal to parse', () => {
    const event = parseEvent(
      JSON.stringify({ session_id: 's', hook_event_name: 'BeforeTool', tool_input: {} }),
    )
    expect(event.kind).toBe('unparsable')
  })

  it('arguments that are not an object are a refusal to parse', () => {
    // An array in place of the argument object was already caught on the first
    // adapter: without the check it passed as empty and the call went
    // unnoticed.
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'BeforeTool',
        tool_name: 'x',
        tool_input: ['ls'],
      }),
    )
    expect(event.kind).toBe('unparsable')
  })

  it('content that is not a string is a parsed event with empty text', () => {
    // There is nothing to neutralize, but provenance still has to be recorded
    // under its source: a result that was not read is not an absent result.
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'AfterTool',
        tool_name: 'web_fetch',
        tool_input: { url: 'https://example.org/' },
        tool_response: { llmContent: { inlineData: { mimeType: 'image/png' } }, error: null },
      }),
    )
    expect(event.kind).toBe('AfterTool')
    expect(event.kind === 'AfterTool' && event.content).toBe('')
    // There was content and we failed to read it as text. The difference from
    // absent content matters: the model read something and we did not.
    expect(event.kind === 'AfterTool' && event.unreadable).toBe(true)
  })

  it('no result at all is not the same as unread content', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'AfterTool',
        tool_name: 'web_fetch',
        tool_input: {},
        tool_response: { llmContent: '', error: 'the network is unreachable' },
      }),
    )
    expect(event.kind === 'AfterTool' && event.unreadable).toBe(false)
  })

  it('content in pieces is glued together by the text fields', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'AfterTool',
        tool_name: 'read_many_files',
        tool_input: {},
        tool_response: {
          llmContent: [{ text: 'the first piece' }, { text: ' and the second' }],
          error: null,
        },
      }),
    )
    expect(event.kind === 'AfterTool' && event.content).toBe('the first piece and the second')
  })

  it('an MCP server name that is not a string does not pass for a name', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'BeforeTool',
        tool_name: 'x',
        tool_input: {},
        mcp_context: { server_name: { toString: 'wildberries' } },
      }),
    )
    expect(event.kind === 'BeforeTool' && event.mcpServer).toBeUndefined()
  })

  it('names from outside are not read through the prototype', () => {
    // "constructor" in the role of a tool name would pass for a real name if
    // the field were not read as an own property.
    const event = parseEvent(JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'x', tool_input: {} }))
    expect(event.sessionId).toBe('default')
  })

  it('deeply nested content does not bring the parse down', () => {
    // The parse NEVER throws: the contents of tool_response are chosen
    // entirely by the tool's server, and the harness would read a thrown
    // exception as "let it through", that is, the result would reach the model
    // unchecked.
    const depth = 50_000
    const raw = `{"session_id":"s","hook_event_name":"AfterTool","tool_name":"t","tool_input":{},`
      + `"tool_response":{"llmContent":${'['.repeat(depth)}"x"${']'.repeat(depth)}}}`
    expect(() => parseEvent(raw)).not.toThrow()
    const event = parseEvent(raw)
    expect(event.kind).toBe('AfterTool')
    // We failed to read it, so the blindness has to be named.
    expect(event.kind === 'AfterTool' && event.unreadable).toBe(true)
  })

  it('an event that is not an object is a refusal to parse', () => {
    expect(parseEvent(JSON.stringify(['BeforeTool'])).kind).toBe('unparsable')
  })
})
