import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'

/**
 * How long a memory write under exposure keeps marking later sessions.
 *
 * Session state lives a day; this lives a month, and the difference is the
 * whole point: the attack this answers is the one that waits. Thirty days
 * rather than forever because an entry nobody has looked at in a month is
 * friction with no one left to read it — and the owner was told on the day.
 */
export const MEMORY_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** More than this and the oldest pieces go first: the directory must not grow without bound. */
const MAX_ENTRIES = 200

export interface MemoryEntry {
  /** A path, or the tool name for a store that has no path. */
  target: string
  /** The untrusted source the writing session had read. */
  source: string
  /** The session that wrote it. */
  sessionId: string
  /** Milliseconds since the epoch. */
  at: number
}

/**
 * The record of memory written after untrusted content was read.
 *
 * This is the one piece of Cordon's state that deliberately outlives a
 * session. Everything else dies within a day because state that survives is
 * state an attacker can aim at; this survives because the attack it answers
 * outlives the session by design — a note written on Monday acts on Thursday,
 * in a session that read nothing untrusted and so carries no mark of its own.
 *
 * It holds no content: a path, a source label, a time. Keeping what was
 * written would mean keeping untrusted text for a month, and the decision
 * does not need it — the fact of the write is what the next session answers
 * to, the same way the exposure mark answers to the fact of the read.
 *
 * Every entry is a file of its own, written once and never rewritten. Hook
 * processes run in parallel, and a read-modify-write of one shared file lets
 * the later writer erase the earlier one's entry without a word — the race
 * SessionStore measured losing twelve times out of twelve. Here nothing is
 * ever read in order to be written back, so there is nothing to lose: the
 * ledger is the union of the pieces on disk. Only expired pieces, the oldest
 * past the cap, and — on the user's word — every piece seen are removed.
 */
export class MemoryLedger {
  private readonly dir: string

  constructor(cordonHome: string, private readonly now: () => number = Date.now) {
    this.dir = join(cordonHome, 'memory')
  }

  /** The latest live entry per target. */
  live(): MemoryEntry[] {
    const cutoff = this.now() - MEMORY_TTL_MS
    const latest = new Map<string, MemoryEntry>()
    for (const { entry } of this.pieces()) {
      if (entry.at <= cutoff) continue
      const seen = latest.get(entry.target)
      if (seen === undefined || seen.at < entry.at) latest.set(entry.target, entry)
    }
    return [...latest.values()].sort((a, b) => a.at - b.at)
  }

  record(entry: Omit<MemoryEntry, 'at'>): void {
    const at = this.now()
    makeDirectory(this.dir)
    const name = `${at}-${randomBytes(8).toString('hex')}.json`
    const path = join(this.dir, name)
    // Through a temporary file and a rename, as the session state: a torn
    // piece would read as a corrupted ledger, that is, as a refusal on every
    // later hook event.
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, entry: { ...entry, at } }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
    this.prune(name)
  }

  /**
   * Forgets every piece this process can see. A piece another process writes
   * after the listing survives, and that is right: it is a newer write than
   * the one the user just reviewed.
   */
  clear(): void {
    for (const { path } of this.pieces()) rmSync(path, { force: true })
  }

  /** Drops expired pieces and the oldest past the cap, never the one just written. */
  private prune(own: string): void {
    const cutoff = this.now() - MEMORY_TTL_MS
    const all = this.pieces()
    const excess = all.length - MAX_ENTRIES
    all.forEach(({ path, name, entry }, index) => {
      if (name === own) return
      if (entry.at <= cutoff || index < excess) rmSync(path, { force: true })
    })
  }

  /**
   * Every piece on disk, oldest first. A missing directory is an empty
   * ledger; anything unreadable is an exception.
   *
   * Empty is the most permissive state there is, so a damaged piece must not
   * read as absent: that would be a poisoned memory carried into every later
   * session with nobody told. The exception travels up to the adapter, where
   * a failed PreToolUse is a deny. A piece vanishing between the listing and
   * the read is another process pruning or clearing it, not damage.
   */
  private pieces(): Array<{ name: string; path: string; entry: MemoryEntry }> {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`the memory ledger is unreadable: ${(error as Error).message}`)
    }

    const out: Array<{ name: string; path: string; entry: MemoryEntry }> = []
    for (const name of names) {
      const path = join(this.dir, name)
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error(`the memory ledger is unreadable: ${(error as Error).message}`)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`the memory ledger is corrupted (${name}): ${(error as Error).message}`)
      }

      const entry = typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'entry')
        ? (parsed as Record<string, unknown>)['entry']
        : undefined
      if (!isEntry(entry)) throw new Error(`the memory ledger is incompatible (${name})`)
      out.push({ name, path, entry })
    }
    return out.sort((a, b) => a.entry.at - b.entry.at)
  }
}

function isEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = (key: string): unknown => (Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined)
  return typeof own('target') === 'string' &&
    typeof own('source') === 'string' &&
    typeof own('sessionId') === 'string' &&
    typeof own('at') === 'number' && Number.isFinite(own('at'))
}
