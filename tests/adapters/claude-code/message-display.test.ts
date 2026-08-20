import { describe, expect, it } from 'vitest'
import { parseEvent } from '../../../src/adapters/claude-code/protocol.js'

describe('parsing the display event', () => {
  it('parses a delta', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'MessageDisplay',
        message_id: 'm1',
        index: 0,
        final: false,
        delta: 'The beginning of the answer',
      }),
    )
    expect(event).toEqual({
      kind: 'MessageDisplay',
      sessionId: 's',
      messageId: 'm1',
      final: false,
      delta: 'The beginning of the answer',
    })
  })

  it('sees the final delta', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'MessageDisplay',
        message_id: 'm1',
        index: 3,
        final: true,
        delta: '',
      }),
    )
    expect(event.kind === 'MessageDisplay' && event.final).toBe(true)
  })

  it('an event without a message identifier does not parse', () => {
    // Without it the deltas cannot be tied together, and tying them at random
    // means attributing pieces of one message to another.
    const event = parseEvent(
      JSON.stringify({ session_id: 's', hook_event_name: 'MessageDisplay', delta: 'some text' }),
    )
    expect(event.kind).toBe('unparsable')
  })

  it('a delta that is not a string is not a parse', () => {
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'MessageDisplay',
        message_id: 'm1',
        final: true,
        delta: { text: 'a decoy' },
      }),
    )
    expect(event.kind).toBe('unparsable')
  })

  it('a non-boolean final means "not final"', () => {
    // The string "true" in this field must not close the message: the footer
    // would attach to a piece of the answer and the remainder would reach the
    // human without it.
    const event = parseEvent(
      JSON.stringify({
        session_id: 's',
        hook_event_name: 'MessageDisplay',
        message_id: 'm1',
        final: 'true',
        delta: 'a piece',
      }),
    )
    expect(event.kind).toBe('MessageDisplay')
    expect(event.kind === 'MessageDisplay' && event.final).toBe(false)
  })

  it('the message identifier is not read through the prototype', () => {
    // The field name comes from outside. An index lookup would return a member
    // of Object.prototype instead of an absent field.
    const event = parseEvent(
      JSON.stringify({ session_id: 's', hook_event_name: 'MessageDisplay', delta: 'some text' }),
    )
    expect(event.kind).toBe('unparsable')
    expect(event.kind === 'unparsable' && event.reason).toContain('message_id')
  })
})
