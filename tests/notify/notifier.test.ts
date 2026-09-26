import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileNotifier } from '../../src/notify/notifier.js'

const EVENT = { at: '2026-09-26T00:00:00Z', decision: 'deny', tool: 'send_email', reason: 'r', source: null }

describe('the journal file', () => {
  it('appends one JSON line per event', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cordon-notify-')), 'events.jsonl')
    const notifier = new FileNotifier(path)
    notifier.notify(EVENT)
    notifier.notify(EVENT)
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('rotates to .1 past the size cap and keeps writing', () => {
    // An autonomous agent writes the journal for weeks; without a cap it
    // fills the disk it shares with the agent's own work.
    const path = join(mkdtempSync(join(tmpdir(), 'cordon-notify-')), 'events.jsonl')
    writeFileSync(path, 'x'.repeat(2048))
    new FileNotifier(path, 1024).notify(EVENT)
    expect(statSync(`${path}.1`).size).toBe(2048)
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('an event is still written when another process rotated first', () => {
    // Two hook processes both see a full file; the second rename finds
    // nothing to move. That must not cost the event it came to write.
    const path = join(mkdtempSync(join(tmpdir(), 'cordon-notify-')), 'events.jsonl')
    new FileNotifier(path, 1024).notify(EVENT)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(false)
  })
})
