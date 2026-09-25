import { readFileSync, renameSync, writeFileSync } from 'node:fs'
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

/** More than this and the oldest entries go first: the file must not grow without bound. */
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
 */
export class MemoryLedger {
  private readonly dir: string
  private readonly path: string

  constructor(cordonHome: string, private readonly now: () => number = Date.now) {
    this.dir = join(cordonHome, 'memory')
    this.path = join(this.dir, 'ledger.json')
  }

  live(): MemoryEntry[] {
    const cutoff = this.now() - MEMORY_TTL_MS
    return this.read().filter((entry) => entry.at > cutoff)
  }

  record(entry: Omit<MemoryEntry, 'at'>): void {
    const kept = this.live().filter((existing) => existing.target !== entry.target)
    kept.push({ ...entry, at: this.now() })
    this.write(kept.slice(-MAX_ENTRIES))
  }

  clear(): void {
    this.write([])
  }

  /**
   * A missing file is an empty ledger; anything unreadable is an exception.
   *
   * Empty is the most permissive state there is, so a damaged ledger must not
   * read as one: that would be a poisoned memory carried into every later
   * session with nobody told. The exception travels up to the adapter, where
   * a failed PreToolUse is a deny.
   */
  private read(): MemoryEntry[] {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`the memory ledger is unreadable: ${(error as Error).message}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`the memory ledger is corrupted: ${(error as Error).message}`)
    }

    const entries = typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'entries')
      ? (parsed as Record<string, unknown>)['entries']
      : undefined
    if (!Array.isArray(entries) || !entries.every(isEntry)) {
      throw new Error('the memory ledger is incompatible')
    }
    return entries
  }

  /** Through a temporary file and a rename, as the session state: see atomicWrite there. */
  private write(entries: MemoryEntry[]): void {
    makeDirectory(this.dir)
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, entries }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.path)
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
