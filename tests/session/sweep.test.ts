import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../../src/session/store.js'
import { TaintStore } from '../../src/provenance/store.js'
import {
  DRAFT_TTL_MS,
  SESSION_TTL_MS,
  SWEEP_INTERVAL_MS,
  SWEEP_MARK,
  sweep,
} from '../../src/session/sweep.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-sweep-'))
}

/** A file's age is set explicitly rather than by waiting: see the project rules. */
function age(path: string, ms: number): void {
  const when = new Date(Date.now() - ms)
  utimesSync(path, when, when)
}

function state(dir: string, sessionId: string): string {
  new SessionStore(dir).save(sessionId, { turn: 1, taint: new TaintStore() })
  const name = readdirSync(join(dir, 'sessions')).find((entry) => entry.endsWith('.json'))
  return join(dir, 'sessions', name!)
}

function draft(dir: string, sessionId: string): string {
  new SessionStore(dir).saveDraft(sessionId, { messageId: 'm1', text: 'a piece of the answer' })
  const names = readdirSync(join(dir, 'drafts'))
  return join(dir, 'drafts', names[names.length - 1]!)
}

describe('sweeping the state', () => {
  it('a state older than its term is deleted', () => {
    const dir = home()
    const path = state(dir, 'yesterdays')
    age(path, SESSION_TTL_MS + 60_000)

    sweep(dir, 'current')

    expect(existsSync(path)).toBe(false)
  })

  it('a fresh state stays', () => {
    const dir = home()
    const path = state(dir, 'yesterdays')

    sweep(dir, 'current')

    expect(existsSync(path)).toBe(true)
  })

  it('a draft lives noticeably less than a state', () => {
    const dir = home()
    const older = draft(dir, 'someone-elses')
    const kept = state(dir, 'someone-elses')
    age(older, DRAFT_TTL_MS + 60_000)
    age(kept, DRAFT_TTL_MS + 60_000)

    sweep(dir, 'current')

    expect(existsSync(older)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })

  it('the files of the current session are not deleted, even past their term', () => {
    const dir = home()
    const keptState = state(dir, 'current')
    const keptDraft = draft(dir, 'current')
    age(keptState, SESSION_TTL_MS * 10)
    age(keptDraft, SESSION_TTL_MS * 10)

    sweep(dir, 'current')

    expect(existsSync(keptState)).toBe(true)
    expect(existsSync(keptDraft)).toBe(true)
  })

  it('an abandoned temporary file is swept too', () => {
    const dir = home()
    const path = `${state(dir, 'someone-elses')}.4242.tmp`
    writeFileSync(path, '{ truncated')
    age(path, SESSION_TTL_MS + 60_000)

    sweep(dir, 'current')

    expect(existsSync(path)).toBe(false)
  })

  it('a fresh temporary file of a neighbouring process is left alone', () => {
    const dir = home()
    const path = `${state(dir, 'someone-elses')}.4242.tmp`
    writeFileSync(path, '{ being written right now')

    sweep(dir, 'current')

    expect(existsSync(path)).toBe(true)
  })

  it('an unrelated file in the directory is not ours and is not deleted', () => {
    const dir = home()
    state(dir, 'someone-elses')
    const alien = join(dir, 'sessions', 'a-note.txt')
    writeFileSync(alien, 'not ours')
    age(alien, SESSION_TTL_MS * 10)

    sweep(dir, 'current')

    expect(existsSync(alien)).toBe(true)
  })

  it('a subdirectory is not deleted', () => {
    const dir = home()
    state(dir, 'someone-elses')
    const nested = join(dir, 'sessions', 'nested')
    mkdirSync(nested)
    age(nested, SESSION_TTL_MS * 10)

    sweep(dir, 'current')

    expect(existsSync(nested)).toBe(true)
  })

  it('the sweep runs no more often than the interval', () => {
    const dir = home()
    sweep(dir, 'current')

    const path = state(dir, 'someone-elses')
    age(path, SESSION_TTL_MS + 60_000)
    sweep(dir, 'current')

    expect(existsSync(path)).toBe(true)
  })

  it('once the interval has passed the sweep runs again', () => {
    const dir = home()
    sweep(dir, 'current')
    age(join(dir, SWEEP_MARK), SWEEP_INTERVAL_MS + 60_000)

    const path = state(dir, 'someone-elses')
    age(path, SESSION_TTL_MS + 60_000)
    sweep(dir, 'current')

    expect(existsSync(path)).toBe(false)
  })

  it('a mark that ran ahead by a fraction of a second does not start a sweep', () => {
    // A fractional mtime against a rounded Date.now(): a fresh mark routinely
    // ends up ahead. A second ahead is the same case, only visible.
    const dir = home()
    sweep(dir, 'current')
    const ahead = new Date(Date.now() + 1000)
    utimesSync(join(dir, SWEEP_MARK), ahead, ahead)

    const path = state(dir, 'someone-elses')
    age(path, SESSION_TTL_MS + 60_000)
    sweep(dir, 'current')

    expect(existsSync(path)).toBe(true)
  })

  it('a mark from the distant future does not cancel the sweep forever', () => {
    const dir = home()
    sweep(dir, 'current')
    const ahead = new Date(Date.now() + SWEEP_INTERVAL_MS * 100)
    utimesSync(join(dir, SWEEP_MARK), ahead, ahead)

    const path = state(dir, 'someone-elses')
    age(path, SESSION_TTL_MS + 60_000)
    sweep(dir, 'current')

    expect(existsSync(path)).toBe(false)
  })
})

describe('the sweep does not step outside its own directories', () => {
  it('a symbolic link outwards does not lead the deletion away', () => {
    const dir = home()
    const outside = join(mkdtempSync(join(tmpdir(), 'cordon-outside-')), 'important.txt')
    writeFileSync(outside, "someone else's file")
    age(outside, SESSION_TTL_MS * 10)

    // The link name deliberately looks like one of our session states.
    state(dir, 'someone-elses')
    const link = join(dir, 'sessions', 'forgery-0123456789abcdef.json')
    symlinkSync(outside, link)

    sweep(dir, 'current')

    expect(existsSync(outside)).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe("someone else's file")
  })

  it('a states directory replaced by a link is not swept at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cordon-substitution-'))
    const outside = mkdtempSync(join(tmpdir(), 'cordon-outside-'))
    const victim = join(outside, 'victim-0123456789abcdef.json')
    writeFileSync(victim, '{}')
    age(victim, SESSION_TTL_MS * 10)
    symlinkSync(outside, join(dir, 'sessions'))

    sweep(dir, 'current')

    expect(existsSync(victim)).toBe(true)
  })
})

describe('a failed sweep stays silent', () => {
  it('a home that does not exist is not an error', () => {
    expect(() => sweep(join(tmpdir(), 'cordon-no-such-home'), 'current')).not.toThrow()
  })

  it('a home without state directories is not an error', () => {
    expect(() => sweep(home(), 'current')).not.toThrow()
  })
})
