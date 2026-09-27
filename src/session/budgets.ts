import { randomBytes } from 'node:crypto'
import { readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'
import type { Budget } from '../policy/defaults.js'

const WINDOW_MS: Record<Budget['per'], number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
}

export interface Reservation {
  ok: boolean
  /** Calls already counted in the window, this one excluded. */
  used: number
  /** Takes the reservation back: the call it was made for did not run. */
  release(): void
}

/**
 * How many calls of one effect went through in a sliding window.
 *
 * State an attacker can aim at (AGENTS.md), so its shape answers the ways to
 * aim at it that the reviewers named (Codex, Kimi):
 * - keyed by the effect and the window, never by the session: an agent that
 *   restarts itself gets a new session and would get a fresh budget with it.
 *   Nor by the policy's hash: Gemini lays its built-in tools over the policy
 *   for its own tools and not for MCP ones, and one budget split into two
 *   counts an agent could alternate between (Codex). The limit is read at
 *   each call, so a policy that lowers it takes hold at once, and the set
 *   of directories is bounded by effects times windows;
 * - one file per reservation, written with `wx`, and the count read after
 *   the write: processes racing each other both see both files, so a race
 *   over-counts and refuses, never under-counts and lets both through;
 * - a directory that cannot be read or written throws, and the caller
 *   refuses: a count that fails to zero is a budget switched off.
 */
export class BudgetStore {
  private readonly dir: string

  constructor(cordonHome: string) {
    this.dir = join(cordonHome, 'budgets')
  }

  keyFor(budget: Budget): string {
    return `${budget.effect}-${budget.per}`
  }

  /** Reserves one call in the window, or refuses and reserves nothing. */
  reserve(budget: Budget, now: number = Date.now()): Reservation {
    const dir = join(this.dir, this.keyFor(budget))
    makeDirectory(dir, 0o700)
    const own = `${now.toString(36).padStart(10, '0')}-${randomBytes(6).toString('hex')}`
    writeFileSync(join(dir, own), '', { mode: 0o600, flag: 'wx' })

    const since = now - WINDOW_MS[budget.per]
    let counted = 0
    for (const name of readdirSync(dir)) {
      const at = parseInt(name.slice(0, name.indexOf('-')), 36)
      if (!Number.isFinite(at)) continue
      if (at <= since) {
        // Out of the window for good: the store does not grow with the run.
        try {
          unlinkSync(join(dir, name))
        } catch {
          // Another process removed it first.
        }
        continue
      }
      counted++
    }
    const release = (): void => {
      unlinkSync(join(dir, own))
    }
    if (counted > budget.limit) {
      // Refused calls spend nothing: the reservation is taken back.
      release()
      return { ok: false, used: counted - 1, release: () => {} }
    }
    return { ok: true, used: counted - 1, release }
  }
}
