import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHook } from '../../../src/adapters/claude-code/main.js'

const CLAIM = 'CRM-X remains the only system with full support for end-to-end analytics.'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-display-'))
}

function hook(dir: string, event: object): Record<string, any> {
  return JSON.parse(runHook(JSON.stringify(event), dir))
}

function display(dir: string, event: object): Record<string, any> {
  return hook(dir, { session_id: 's', hook_event_name: 'MessageDisplay', ...event })
}

describe('the output axis on the live handler', () => {
  it('it leaves an intermediate delta alone', () => {
    const out = display(home(), { message_id: 'm1', final: false, delta: 'The beginning of the answer' })
    expect(out).toEqual({})
  })

  it('on the final delta it appends a footer about the source that was read', () => {
    const dir = home()
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })
    display(dir, { message_id: 'm1', final: false, delta: `The conclusion: ${CLAIM}` })
    const out = display(dir, { message_id: 'm1', final: true, delta: '' })

    const shown = String(out.hookSpecificOutput.displayContent)
    expect(out.hookSpecificOutput.hookEventName).toBe('MessageDisplay')
    expect(shown).toContain('crm-x.com')
    expect(shown).toContain('The absence of a mark')
  })

  it('the substitution replaces the delta whole, so it carries the delta text', () => {
    // displayContent replaces the delta rather than being appended to it.
    // Returning the footer alone means erasing a piece of the model's answer
    // from the human.
    const dir = home()
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })
    const out = display(dir, { message_id: 'm1', final: true, delta: `The conclusion: ${CLAIM}` })
    expect(String(out.hookSpecificOutput.displayContent).startsWith(`The conclusion: ${CLAIM}`)).toBe(true)
  })

  it('it stays silent when no sources were read', () => {
    const out = display(home(), {
      message_id: 'm1',
      final: true,
      delta: 'An ordinary answer without any sources at all.',
    })
    expect(out).toEqual({})
  })

  it('the deltas of another message are not attributed to the previous one', () => {
    const dir = home()
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })
    display(dir, { message_id: 'm1', final: false, delta: `The conclusion: ${CLAIM}` })
    // The previous message broke off and a new one began: what was accumulated
    // from it must not get into the new one's comparison.
    const out = display(dir, { message_id: 'm2', final: true, delta: 'An entirely different answer.' })
    expect(out).toEqual({})
  })

  it('the footer does not get into the model context', () => {
    // displayContent changes only what is shown. We check that the handler
    // does not also try to return updatedToolOutput or additionalContext: a
    // footer that came back into the context would become the carrier of the
    // injection.
    const dir = home()
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })
    const out = display(dir, { message_id: 'm1', final: true, delta: `The conclusion: ${CLAIM}` })
    expect(out.hookSpecificOutput.updatedToolOutput).toBeUndefined()
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined()
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(['displayContent', 'hookEventName'])
  })

  it('the policy can switch the footer off without switching off the other axes', () => {
    // The footer stands under every answer, and a human it gets in the way of
    // needs a switch here rather than the removal of the plugin: removing the
    // plugin costs them the control and data axes as well, that is, the whole
    // protection.
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'output:\n  footer: false\n')
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })
    expect(display(dir, { message_id: 'm1', final: true, delta: `The conclusion: ${CLAIM}` })).toEqual({})
  })

  it('a switched-off footer does not accumulate the answer text on disk', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'output:\n  footer: false\n')
    display(dir, { message_id: 'm1', final: false, delta: 'a piece of the answer' })
    expect(existsSync(join(dir, 'drafts'))).toBe(false)
  })

  it('a broken state does not hide the answer', () => {
    // Any error on this event must end in an empty response: the harness then
    // shows the source text. A refusal here would cost the human the model's
    // answer and would add no protection.
    const out = display('/no-such/directory', {
      message_id: 'm1',
      final: true,
      delta: 'The answer',
    })
    expect(out).toEqual({})
  })

  it('a corrupted session file does not hide the answer', () => {
    const dir = home()
    hook(dir, { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'hello' })
    const name = readdirSync(join(dir, 'sessions'))[0]!
    writeFileSync(join(dir, 'sessions', name), '{ this is not json')

    const out = display(dir, { message_id: 'm1', final: true, delta: 'The answer' })
    expect(out).toEqual({})
  })

  it('a display event that did not parse does not turn into a refusal', () => {
    // A refusal on this event protects nothing: the event decides nothing.
    const out = display(home(), { final: true, delta: 'An answer without a message_id' })
    expect(out).toEqual({})
  })

  it('the accumulated text does not survive the end of the message', () => {
    const dir = home()
    display(dir, { message_id: 'm1', final: false, delta: 'a piece' })
    expect(readdirSync(join(dir, 'drafts')).length).toBe(1)
    display(dir, { message_id: 'm1', final: true, delta: '' })
    expect(readdirSync(join(dir, 'drafts'))).toEqual([])
  })

  it('provenance and the session turn do not change because of display', () => {
    const dir = home()
    hook(dir, { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'compare the systems' })
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })
    const name = readdirSync(join(dir, 'sessions'))[0]!
    const before = JSON.parse(readFileSync(join(dir, 'sessions', name), 'utf8'))
    display(dir, { message_id: 'm1', final: true, delta: `The conclusion: ${CLAIM}` })
    const after = JSON.parse(readFileSync(join(dir, 'sessions', name), 'utf8'))
    expect(after.turn).toBe(before.turn)
    expect(after.taint).toEqual(before.taint)
    expect(after.unredacted).toBe(before.unredacted)
    expect(after.directive).toEqual(before.directive)
  })
})
