import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BudgetStore } from '../../src/session/budgets.js'

/**
 * Budgets are state an attacker can aim at (AGENTS.md), so their shape is
 * the reviewers' (Codex, Kimi): keyed by the effect and the window, never
 * by a session an agent can restart nor by a policy hash that differs
 * between two harness paths; one file per reservation, so processes
 * racing each other can only over-count, never lose a call; a store that
 * cannot be read refuses.
 */

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-budgets-'))
}

const HOUR = { effect: 'network-egress' as const, limit: 3, per: 'hour' as const }

describe('BudgetStore', () => {
  it('reserves up to the limit, then refuses', () => {
    const store = new BudgetStore(home())
    const now = Date.parse('2026-09-27T10:00:00Z')
    expect([1, 2, 3].map(() => store.reserve(HOUR, now).ok)).toEqual([true, true, true])
    const over = store.reserve(HOUR, now)
    expect(over.ok).toBe(false)
    expect(over.used).toBe(3)
  })

  it('a refused call spends nothing', () => {
    const store = new BudgetStore(home())
    const now = Date.parse('2026-09-27T10:00:00Z')
    for (let i = 0; i < 5; i++) store.reserve(HOUR, now)
    expect(store.reserve(HOUR, now + 3_600_001).ok).toBe(true)
  })

  it('the window slides: an hour later there is room again', () => {
    const store = new BudgetStore(home())
    const now = Date.parse('2026-09-27T10:00:00Z')
    for (let i = 0; i < 3; i++) store.reserve(HOUR, now)
    expect(store.reserve(HOUR, now + 30 * 60_000).ok).toBe(false)
    expect(store.reserve(HOUR, now + 3_600_001).ok).toBe(true)
  })

  it('is shared by every session and every process under the same policy', () => {
    const dir = home()
    const now = Date.parse('2026-09-27T10:00:00Z')
    for (let i = 0; i < 3; i++) new BudgetStore(dir).reserve(HOUR, now)
    expect(new BudgetStore(dir).reserve(HOUR, now).ok).toBe(false)
  })

  it('another effect or another window has its own budget', () => {
    const store = new BudgetStore(home())
    const now = Date.parse('2026-09-27T10:00:00Z')
    for (let i = 0; i < 3; i++) store.reserve(HOUR, now)
    expect(store.reserve({ ...HOUR, effect: 'create' }, now).ok).toBe(true)
    expect(store.reserve({ ...HOUR, per: 'day' }, now).ok).toBe(true)
  })

  it('a reservation can be taken back', () => {
    const store = new BudgetStore(home())
    const now = Date.parse('2026-09-27T10:00:00Z')
    for (let i = 0; i < 3; i++) store.reserve(HOUR, now).release()
    expect(store.reserve(HOUR, now).used).toBe(0)
  })

  it('a store it cannot read refuses rather than counting from zero', () => {
    const dir = home()
    // Where the budget's directory should be, a file: unreadable as a count.
    mkdirSync(join(dir, 'budgets'), { recursive: true })
    const store = new BudgetStore(dir)
    const key = store.keyFor(HOUR)
    writeFileSync(join(dir, 'budgets', key), 'not a directory')
    expect(() => store.reserve(HOUR, Date.now())).toThrow()
  })

  it('a reservation it cannot write refuses too', () => {
    const dir = home()
    mkdirSync(join(dir, 'budgets'), { recursive: true })
    chmodSync(join(dir, 'budgets'), 0o500)
    try {
      expect(() => new BudgetStore(dir).reserve(HOUR, Date.now())).toThrow()
    } finally {
      chmodSync(join(dir, 'budgets'), 0o700)
    }
  })
})
