import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHook } from '../../../src/adapters/claude-code/main.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-main-'))
}

describe('runHook', () => {
  it('the default policy forbids creation', () => {
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'a', hook_event_name: 'PreToolUse',
      tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' },
    }), home()))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('the default policy allows reading', () => {
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'a', hook_event_name: 'PreToolUse',
      tool_name: 'Read', tool_input: { file_path: '/tmp/x' },
    }), home()))
    expect(out).toEqual({})
  })

  it('an empty stdin is a refusal, not a pass', () => {
    const out = JSON.parse(runHook('', home()))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('an unreachable home directory is a refusal', () => {
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {},
    }), '/proc/no-such/path'))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('writing into our own config is forbidden', () => {
    const dir = home()
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'a', hook_event_name: 'PreToolUse',
      tool_name: 'Write', tool_input: { file_path: join(dir, 'policy.yaml'), content: 'mode: off' },
    }), dir))
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('self-protection')
  })

  it('the output is always one line of parseable JSON', () => {
    // The harness reads stdout as JSON whole. An extra line or a fragment
    // means it will not see the decision, that is, it will let the call
    // through.
    const out = runHook(JSON.stringify({
      session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    }), home())
    expect(out.includes('\n')).toBe(false)
    expect(() => JSON.parse(out)).not.toThrow()
  })
})

/**
 * Eight ways of making the entry point print something other than a refusal on
 * unfit input. Every one of them must give a deny, or an empty object where
 * there must be no decision at all.
 *
 * The entry point is synchronous deliberately: per section 9.1 a hook that
 * times out does NOT block the call, that is, hanging equals letting through.
 * So not one of the cases below has the right to wait or to throw outwards.
 */
describe('the entry point: unfit input', () => {
  const call = { session_id: 'z', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/a', content: 'b' } }

  it('1. an empty stdin', () => {
    expect(JSON.parse(runHook('', home())).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('2. not JSON', () => {
    expect(JSON.parse(runHook('this is not json', home())).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('3. a JSON array instead of an object', () => {
    expect(JSON.parse(runHook('[{"hook_event_name":"PreToolUse"}]', home())).hookSpecificOutput.permissionDecision)
      .toBe('deny')
  })

  it('4. an event without a name produces no decision', () => {
    // Not a deny: there is no event name, so there is no call to forbid
    // either. Printing a decision here means making it blindly.
    expect(JSON.parse(runHook(JSON.stringify({ session_id: 'z', tool_name: 'Write' }), home()))).toEqual({})
  })

  it('5. an unreachable home directory', () => {
    expect(JSON.parse(runHook(JSON.stringify(call), '/proc/no-such/path')).hookSpecificOutput.permissionDecision)
      .toBe('deny')
  })

  it('6. a broken policy.yaml', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'profile:\n  effects: [read\n')
    expect(JSON.parse(runHook(JSON.stringify(call), dir)).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('7. a broken session state', () => {
    const dir = home()
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    // The store derives the state file name from the identifier itself, so we
    // first let it write the state and then corrupt what was written.
    runHook(JSON.stringify({ ...call, tool_name: 'Read', tool_input: {} }), dir)
    runHook(JSON.stringify({ session_id: 'z', hook_event_name: 'UserPromptSubmit', prompt: 'hello' }), dir)
    for (const name of readdirSync(join(dir, 'sessions'))) {
      writeFileSync(join(dir, 'sessions', name), 'junk')
    }
    expect(JSON.parse(runHook(JSON.stringify(call), dir)).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('8. an exception inside the core', () => {
    // Arguments deeper than the traversal limit: the core throws deliberately,
    // and outwards that must come out as a refusal rather than a crashed
    // process.
    let deep: Record<string, unknown> = { note: 'the bottom' }
    for (let i = 0; i < 40; i += 1) deep = { nested: deep }
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'z', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: deep,
    }), home()))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a broken policy.yaml on PostToolUse does not print another event\'s decision', () => {
    // The failure happened before the core came up, but the event is known
    // right after parsing. Printing a PreToolUse decision in reply to a
    // PostToolUse means printing a shape that event does not have: the harness
    // silently drops it, and it looks like protection that fired.
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'profile:\n  effects: [read\n')
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'q', hook_event_name: 'PostToolUse', tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' }, tool_response: 'some text',
    }), dir))
    expect(out).toEqual({})
  })

  it('a broken state on PostToolUse neither substitutes the output nor makes a decision', () => {
    // The direction of a refusal depends on the event: on PostToolUse the tool
    // has already run, there is nothing to forbid. Printing a PreToolUse
    // decision here means printing a shape that event does not have.
    const dir = home()
    runHook(JSON.stringify({ session_id: 'p', hook_event_name: 'UserPromptSubmit', prompt: 'hello' }), dir)
    for (const name of readdirSync(join(dir, 'sessions'))) {
      writeFileSync(join(dir, 'sessions', name), 'junk')
    }
    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'p', hook_event_name: 'PostToolUse', tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' }, tool_response: 'some text',
    }), dir))
    expect(out).toEqual({})
  })
})
