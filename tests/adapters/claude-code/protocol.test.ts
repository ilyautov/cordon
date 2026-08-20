import { describe, expect, it } from 'vitest'
import { parseEvent, renderDecision } from '../../../src/adapters/claude-code/protocol.js'
import type { Decision } from '../../../src/core/types.js'

describe('parseEvent', () => {
  it('parses PreToolUse', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'abc',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    }))
    expect(event.kind).toBe('PreToolUse')
    expect(event.sessionId).toBe('abc')
    expect(event.kind === 'PreToolUse' && event.call.tool).toBe('Bash')
  })

  it('parses PostToolUse together with the result', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'abc',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/a' },
      tool_response: 'the contents',
    }))
    expect(event.kind).toBe('PostToolUse')
    expect(event.kind === 'PostToolUse' && event.response).toBe('the contents')
  })

  it('parses UserPromptSubmit', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'abc',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'take a look at the report',
    }))
    expect(event.kind === 'UserPromptSubmit' && event.prompt).toBe('take a look at the report')
  })

  it('an unfamiliar event is not an error but an ignore', () => {
    const event = parseEvent(JSON.stringify({ session_id: 'a', hook_event_name: 'SessionEnd' }))
    expect(event.kind).toBe('ignored')
  })

  it('broken JSON is a parse failure, not an exception', () => {
    expect(parseEvent('{ not json').kind).toBe('unparsable')
  })

  it('a missing session_id gives a fallback identifier', () => {
    const event = parseEvent(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }))
    expect(event.sessionId).toBe('default')
  })
})

describe('renderDecision', () => {
  it('allow prints an empty object', () => {
    expect(renderDecision({ kind: 'allow' }, 'autonomous')).toEqual({})
  })

  it('deny prints the decision with a reason', () => {
    const out = renderDecision({ kind: 'deny', reason: 'outside the certificate' }, 'autonomous')
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'outside the certificate',
    })
  })

  it('ask prints ask', () => {
    const out = renderDecision({ kind: 'ask', reason: 'confirmation is needed' }, 'autonomous')
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask')
  })

  it('in interactive mode the quarantine is shown to the user', () => {
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'clean', price: 1290 }, removed: ['text'], reason: 'it was cut out' },
      'interactive',
    )
    expect(out.hookSpecificOutput?.updatedInput).toEqual({ text: 'clean', price: 1290 })
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('it was cut out')
  })

  it('in autonomous mode the quarantine goes without a decision', () => {
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'clean' }, removed: ['text'], reason: 'it was cut out' },
      'autonomous',
    )
    expect(out.hookSpecificOutput?.updatedInput).toEqual({ text: 'clean' })
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('unchanged fields get into updatedInput too', () => {
    // The harness replaces the argument object whole rather than merging it
    // field by field. A lost field means a call with a missing argument.
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'clean', nmId: 1937461028, dryRun: false }, removed: ['text'], reason: 'r' },
      'autonomous',
    )
    expect(Object.keys(out.hookSpecificOutput?.updatedInput ?? {}).sort()).toEqual(['dryRun', 'nmId', 'text'])
  })

  it('allow is still printed as an empty object in both modes', () => {
    expect(renderDecision({ kind: 'allow' }, 'interactive')).toEqual({})
    expect(renderDecision({ kind: 'allow' }, 'autonomous')).toEqual({})
  })

  it('the quarantine stays a PreToolUse event in both modes', () => {
    // The event name in the substitution has to match the harness event: a
    // mismatch is exactly the quiet failure where the substitution is silently
    // dropped.
    const quarantine: Decision = { kind: 'rewrite', args: { text: 'clean' }, removed: ['text'], reason: 'r' }
    expect(renderDecision(quarantine, 'interactive').hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    expect(renderDecision(quarantine, 'autonomous').hookSpecificOutput?.hookEventName).toBe('PreToolUse')
  })

  it('the arguments that were cut are named in the reason shown to the human', () => {
    // The human is confirming a modified call, so they have to see what
    // exactly changed. A reason without the argument names does not give that.
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'clean' }, removed: ['text'], reason: 'the tainted part was cut out' },
      'interactive',
    )
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('text')
  })
})

// Below are the divergences from the plan. In the plan a `tool_input` of any
// shape turned into an empty object, that is, a call with a string in place of
// arguments reached the gate without a single argument and passed both axes as
// clean.
describe('parseEvent: the event fields come from outside', () => {
  it('a non-object tool_input on PreToolUse is a refusal to parse', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'a',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: 'rm -rf /',
    }))
    expect(event.kind).toBe('unparsable')
  })

  it('a non-object tool_input on PostToolUse does not hinder cleaning the result', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'a',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: ['/a'],
      tool_response: 'the contents',
    }))
    expect(event.kind).toBe('PostToolUse')
    expect(event.kind === 'PostToolUse' && event.response).toBe('the contents')
  })

  it('a field from the prototype does not become the event name', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'a',
      __proto__: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    }))
    expect(event.kind).toBe('ignored')
  })

  it('a non-string tool name is rejected by the core itself', () => {
    const event = parseEvent(JSON.stringify({
      session_id: 'a',
      hook_event_name: 'PreToolUse',
      tool_name: { toString: 'Bash' },
      tool_input: {},
    }))
    expect(event.kind === 'PreToolUse' && event.call.tool).toBe('')
  })
})
