import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHook } from '../../../src/adapters/claude-code/main.js'
import { SessionStore } from '../../../src/session/store.js'
import { TaintStore } from '../../../src/provenance/store.js'
import { SESSION_TTL_MS } from '../../../src/session/sweep.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-sweep-'))
}

/** A file's age is set explicitly rather than by waiting. */
function stale(dir: string, sessionId: string): string {
  new SessionStore(dir).save(sessionId, { turn: 1, taint: new TaintStore() })
  const name = readdirSync(join(dir, 'sessions'))[0]!
  const path = join(dir, 'sessions', name)
  const when = new Date(Date.now() - SESSION_TTL_MS - 60_000)
  utimesSync(path, when, when)
  return path
}

describe('the sweep in the course of events', () => {
  it('a user message sweeps away the state of a long-finished session', () => {
    const dir = home()
    const old = stale(dir, 'the-day-before-yesterday')

    const out = JSON.parse(runHook(JSON.stringify({
      session_id: 'today',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    }), dir))

    expect(out).toEqual({})
    expect(existsSync(old)).toBe(false)
  })

  it('the hot path does not walk the directory: PreToolUse does not sweep', () => {
    const dir = home()
    const old = stale(dir, 'the-day-before-yesterday')

    runHook(JSON.stringify({
      session_id: 'today',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(tmpdir(), 'x.txt') },
    }), dir)

    expect(existsSync(old)).toBe(true)
  })

  it('the sweep does not cancel parsing the narrowing directive', () => {
    const dir = home()
    stale(dir, 'the-day-before-yesterday')

    runHook(JSON.stringify({
      session_id: 'today',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'cordon: scope read',
    }), dir)

    expect(new SessionStore(dir).load('today').directive).toEqual(['read'])
  })
})
