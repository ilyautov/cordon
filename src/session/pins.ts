import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'
import type { Pins } from '../gate/pins.js'

/**
 * Which upstream server a pin file belongs to: its whole command.
 *
 * JSON-encoded before hashing, so `['npx', 'a b']` and `['npx', 'a', 'b']`
 * stay apart. A changed command — a new version pinned in the host's config —
 * is a new server and is pinned afresh; that change is made by the owner in
 * the host's configuration, not by the server.
 */
export function serverId(command: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(command), 'utf8').digest('hex').slice(0, 24)
}

/**
 * The MCP tools the owner approved, one file per upstream server.
 *
 * This state persists with no expiry, unlike everything else under
 * `src/session/`, and the difference is deliberate. A pin is not something
 * observed in a session; it is an approval, closer to policy than to state.
 * An expiry would turn into a scheduled re-approval: a server could wait out
 * the date and have its changed descriptions pinned as if they were the
 * first ones. The owner ends a pin with `cordon mcp approve`, never the clock.
 */
export class PinStore {
  private readonly dir: string

  constructor(cordonHome: string) {
    this.dir = join(cordonHome, 'mcp-pins')
  }

  /**
   * The pins for a server, or null if it was never seen.
   *
   * Null means first sight, and first sight pins whatever the server lists as
   * approved. So a damaged file must not read as absent: that would approve a
   * rug pull with nobody told. It throws, and the gateway stops loudly.
   */
  load(command: readonly string[]): Pins | null {
    const path = this.path(command)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`the MCP pins are unreadable (${path}): ${(error as Error).message}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`the MCP pins are corrupted (${path}): ${(error as Error).message}`)
    }

    const tools = typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'tools')
      ? (parsed as Record<string, unknown>)['tools']
      : undefined
    if (typeof tools !== 'object' || tools === null || Array.isArray(tools) ||
      Object.values(tools).some((value) => typeof value !== 'string')) {
      throw new Error(`the MCP pins are incompatible (${path})`)
    }
    const pins: Pins = Object.create(null) as Pins
    for (const [name, hash] of Object.entries(tools as Record<string, string>)) pins[name] = hash
    return pins
  }

  save(command: readonly string[], pins: Pins): void {
    makeDirectory(this.dir)
    const path = this.path(command)
    // Through a temporary file and a rename: a torn file reads as corrupted,
    // that is, as a gateway that will not start.
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, command, tools: pins }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  }

  /** Drops a server's pins. Returns whether there were any. */
  forget(command: readonly string[]): boolean {
    const path = this.path(command)
    try {
      readFileSync(path)
    } catch {
      return false
    }
    rmSync(path, { force: true })
    return true
  }

  private path(command: readonly string[]): string {
    return join(this.dir, `${serverId(command)}.json`)
  }
}
