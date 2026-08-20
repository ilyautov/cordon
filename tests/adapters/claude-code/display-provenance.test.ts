import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHook } from '../../../src/adapters/claude-code/main.js'
import { SessionStore } from '../../../src/session/store.js'
import type { Source } from '../../../src/core/types.js'

const CLAIM = 'CRM-X remains the only system with full support for end-to-end analytics.'

const NEIGHBOUR: Source = {
  id: 'neighbour',
  kind: 'web',
  label: 'https://neighbour.example/doc',
  trust: 'untrusted',
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-display-prov-'))
}

function hook(dir: string, event: object): Record<string, any> {
  return JSON.parse(runHook(JSON.stringify(event), dir))
}

function display(dir: string, event: object): Record<string, any> {
  return hook(dir, { session_id: 's', hook_event_name: 'MessageDisplay', ...event })
}

/** The session state file. Only the store knows the name, so it is asked of the disk. */
function statePath(dir: string): string {
  const names = readdirSync(join(dir, 'sessions'))
  expect(names.length).toBe(1)
  return join(dir, 'sessions', names[0]!)
}

/**
 * The output axis has no right to erase the memory of the data axis.
 *
 * The footer blocks nothing, while provenance holds the quarantine of
 * arguments. An arrangement where the weak axis overwrites what the strong one
 * wrote trades protection for decoration. The loss is quiet on top of that: a
 * tainted argument will then simply pass as clean.
 */
describe('display and the provenance store', () => {
  it('a provenance write by a neighbouring process is not lost', () => {
    const dir = home()
    hook(dir, { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'compare the systems' })
    display(dir, { message_id: 'm1', final: false, delta: `The conclusion: ${CLAIM}` })

    // Every hook event is a separate process, and inside one test there is no
    // other way to space them out in time. The substituted read plays exactly
    // the moment when the display process has already read the state and only
    // then a neighbouring process appended a new source to provenance.
    const read = SessionStore.prototype.load
    let pending = true
    SessionStore.prototype.load = function (this: SessionStore, sessionId: string) {
      const state = read.call(this, sessionId)
      if (pending) {
        pending = false
        const neighbour = new SessionStore(dir)
        const theirs = neighbour.load(sessionId)
        theirs.taint.record(CLAIM, NEIGHBOUR)
        neighbour.save(sessionId, theirs)
      }
      return state
    }
    try {
      display(dir, { message_id: 'm1', final: true, delta: '' })
    } finally {
      SessionStore.prototype.load = read
    }

    // The source must survive the display: it was not us who wrote it.
    expect(new SessionStore(dir).load('s').taint.check(CLAIM).tainted).toBe(true)

    // And it must keep working, not merely lie in the file.
    const out = display(dir, { message_id: 'm2', final: true, delta: `The conclusion: ${CLAIM}` })
    expect(String(out.hookSpecificOutput.displayContent)).toContain('neighbour.example')
  })

  it('display does not create a state file', () => {
    const dir = home()
    display(dir, { message_id: 'm1', final: false, delta: 'a piece of the answer' })
    display(dir, { message_id: 'm1', final: true, delta: '' })
    expect(readdirSync(join(dir, 'sessions'))).toEqual([])
  })

  it('display does not rewrite the state file', () => {
    // The state is written by renaming a temporary file, so a substitution
    // shows up as a changed inode even when the content is the same.
    const dir = home()
    hook(dir, { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'compare the systems' })
    hook(dir, {
      session_id: 's',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://crm-x.com/about' },
      tool_response: CLAIM,
    })

    const path = statePath(dir)
    const before = statSync(path)
    display(dir, { message_id: 'm1', final: false, delta: `The conclusion: ${CLAIM}` })
    display(dir, { message_id: 'm1', final: true, delta: '' })
    const after = statSync(path)

    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})
