import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEMORY_TTL_MS, MemoryLedger } from '../../src/session/memory.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-memory-'))
}

const entry = { target: '/srv/project/CLAUDE.md', source: 'https://evil.example/page', sessionId: 's1' }

describe('MemoryLedger', () => {
  it('starts empty when nothing was ever recorded', () => {
    expect(new MemoryLedger(home()).live()).toEqual([])
  })

  it('a recorded write is live for the next process', () => {
    const dir = home()
    new MemoryLedger(dir).record(entry)
    const [live] = new MemoryLedger(dir).live()
    expect(live?.target).toBe('/srv/project/CLAUDE.md')
    expect(live?.source).toBe('https://evil.example/page')
  })

  it('a second write to the same target keeps one entry, the latest', () => {
    const dir = home()
    let now = 1_000
    const ledger = new MemoryLedger(dir, () => now)
    ledger.record(entry)
    now = 2_000
    ledger.record({ ...entry, source: 'https://other.example/' })
    const live = new MemoryLedger(dir, () => now).live()
    expect(live).toHaveLength(1)
    expect(live[0]?.at).toBe(2_000)
    expect(live[0]?.source).toBe('https://other.example/')
  })

  it('an entry past its lifetime is no longer live', () => {
    const dir = home()
    new MemoryLedger(dir, () => 0).record(entry)
    expect(new MemoryLedger(dir, () => MEMORY_TTL_MS - 1).live()).toHaveLength(1)
    expect(new MemoryLedger(dir, () => MEMORY_TTL_MS + 1).live()).toEqual([])
  })

  it('clear forgets every entry', () => {
    const dir = home()
    const ledger = new MemoryLedger(dir)
    ledger.record(entry)
    ledger.clear()
    expect(new MemoryLedger(dir).live()).toEqual([])
  })

  it('a corrupted ledger throws rather than reading as empty', () => {
    // Empty is the most permissive state: a ledger that reads as empty after
    // being damaged is a carried-over poisoned memory nobody is told about.
    const dir = home()
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'ledger.json'), '{ not json')
    expect(() => new MemoryLedger(dir).live()).toThrow(/memory ledger/)
  })

  it('a ledger of the wrong shape throws', () => {
    const dir = home()
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'ledger.json'), JSON.stringify({ version: 1, entries: 'x' }))
    expect(() => new MemoryLedger(dir).live()).toThrow(/memory ledger/)
  })
})
