import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { holdSession } from '../../src/session/hold.js'
import { MAX_READ_IDS, SessionStore, noteRead } from '../../src/session/store.js'

describe('holdSession', () => {
  it('holds the session and counts a new read, even when it was held already', () => {
    // Codex, reviewing the connectors: an approval is bound to the reads so
    // far, and a hold that left them as they were kept an approval given
    // before the new result spendable after it.
    const home = mkdtempSync(join(tmpdir(), 'cordon-hold-'))
    expect(holdSession(home, 's')).toBe(true)
    const first = new SessionStore(home).load('s')
    expect(first.unredacted).toBe(true)
    expect(holdSession(home, 's')).toBe(true)
    const second = new SessionStore(home).load('s')
    expect(second.readIds!.length).toBe(first.readIds!.length + 1)
  })
})

describe('noteRead', () => {
  it('a new read changes the kept ids even after the clock went back', () => {
    // Codex, reviewing the connectors: ids sorted by time and cut to the
    // newest dropped a read stamped earlier than the kept ones, so the
    // approval bound to them stayed spendable.
    const ahead = (Date.now() + 1_000_000).toString(36)
    const full = Array.from({ length: MAX_READ_IDS }, (_, i) => `${ahead}-${i.toString(16).padStart(12, '0')}`)
    expect(noteRead(full)).not.toEqual(full)
  })
})

