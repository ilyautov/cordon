import { describe, expect, it } from 'vitest'
import type { Decision } from '../../../src/core/types.js'
import { renderDecision } from '../../../src/adapters/gemini-cli/protocol.js'

describe('a gate decision in the Gemini shape', () => {
  it('permission is an empty response', () => {
    expect(renderDecision({ kind: 'allow' }, 'interactive')).toEqual({})
  })

  it('a refusal carries the reason', () => {
    const out = renderDecision({ kind: 'deny', reason: 'outside the certificate: financial' }, 'interactive')
    expect(out.decision).toBe('deny')
    expect(out.reason).toContain('financial')
  })

  it('in interactive mode it asks', () => {
    const out = renderDecision({ kind: 'ask', reason: 'the argument would change its addressee' }, 'interactive')
    expect(out.decision).toBe('ask')
  })

  it('in autonomous mode a question turns into a refusal', () => {
    // Two reasons at once: there is nobody to ask, and a forced ask in
    // headless mode, judging by the harness code, hangs rather than fails. A
    // hung hook is worse than a failed one.
    const out = renderDecision({ kind: 'ask', reason: 'the argument would change its addressee' }, 'autonomous')
    expect(out.decision).toBe('deny')
    expect(out.reason).toContain('addressee')
  })

  it('the quarantine substitutes the arguments whole', () => {
    const out = renderDecision(
      { kind: 'rewrite', args: { path: '/tmp/a', text: 'cleaned' }, removed: ['text'], reason: 'quarantine' },
      'interactive',
    )
    expect(out.hookSpecificOutput?.tool_input).toEqual({ path: '/tmp/a', text: 'cleaned' })
  })

  it('the quarantine is visible to the human in interactive mode', () => {
    // A silently edited call is indistinguishable from an unedited one, and
    // indistinguishability is what this whole project is built against.
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'cleaned' }, removed: ['text'], reason: 'the address was cut out' },
      'interactive',
    )
    expect(out.systemMessage).toContain('quarantine')
    expect(out.systemMessage).toContain('the address was cut out')
    // The names of the changed arguments are given: the human has to see what
    // exactly changed in the call.
    expect(out.systemMessage).toContain('text')
  })

  it('the quarantine is visible to the human in autonomous mode too', () => {
    // systemMessage neither asks nor holds the call back, it only writes into
    // the transcript. Staying silent in autonomous mode would leave the only
    // trace of the edit in the notification file, which the human does not
    // always open.
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'cleaned' }, removed: ['text'], reason: 'the address was cut out' },
      'autonomous',
    )
    expect(out.hookSpecificOutput?.tool_input).toEqual({ text: 'cleaned' })
    expect(out.systemMessage).toContain('quarantine')
  })

  it('the quarantine asks nothing and forbids nothing', () => {
    // The call has already been fixed, there is nothing to ask about. Plus an
    // ask in autonomous mode on this harness, judging by the code, hangs.
    const out = renderDecision(
      { kind: 'rewrite', args: { text: 'cleaned' }, removed: [], reason: 'quarantine' },
      'interactive',
    )
    expect(out.decision).toBeUndefined()
  })

  it('a decision never appends to the model context', () => {
    for (const mode of ['interactive', 'autonomous'] as const) {
      const decisions: Decision[] = [
        { kind: 'deny', reason: 'r' },
        { kind: 'ask', reason: 'r' },
        { kind: 'rewrite', args: {}, removed: [], reason: 'r' },
      ]
      for (const decision of decisions) {
        expect(renderDecision(decision, mode).hookSpecificOutput?.additionalContext).toBeUndefined()
      }
    }
  })
})
