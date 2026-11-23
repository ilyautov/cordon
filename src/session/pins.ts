import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'
import { comparePins, fingerprint, pinnedDeclaration, shadows, type HeldTool, type ListedTool, type Pins } from '../gate/pins.js'

/** The whole argv distinguishes e.g. one argument containing a space from two arguments. */
export function serverId(command: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(command), 'utf8').digest('hex').slice(0, 24)
}

interface PinFile {
  command: readonly string[]
  tools: Pins
  definitions: Record<string, ListedTool>
  pending: Record<string, ListedTool>
}

export interface PinChange {
  id: string
  command: readonly string[]
  beforeHash: string | null
  before?: ListedTool
  after: ListedTool
}

function dictionary<T>(values?: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), values)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function declarations(value: unknown): value is Record<string, ListedTool> {
  return record(value) && Object.entries(value).every(([name, tool]) => record(tool) && tool.name === name)
}

function change(file: PinFile, candidate: ListedTool): PinChange {
  const beforeHash = file.tools[candidate.name] ?? null
  // Bind the ID to the transition itself. Looking it up under the writer lock
  // makes it impossible for today's ID to approve tomorrow's different bytes.
  const id = createHash('sha256').update(JSON.stringify([
    file.command, candidate.name, beforeHash, fingerprint(candidate),
  ])).digest('hex')
  return { id, command: file.command, beforeHash, before: file.definitions[candidate.name], after: candidate }
}

export class PinStore {
  private readonly dir: string

  constructor(cordonHome: string) {
    this.dir = join(cordonHome, 'mcp-pins')
  }

  load(command: readonly string[]): Pins | null {
    return this.read(serverId(command))?.tools ?? null
  }

  /** Accept hash-only pins from earlier releases. Only a matching observation can fill in their old text. */
  save(command: readonly string[], pins: Pins): void {
    this.locked(() => this.write({ command, tools: pins, definitions: dictionary(), pending: dictionary() }))
  }

  forget(command: readonly string[]): boolean {
    return this.locked(() => {
      const id = serverId(command)
      try {
        rmSync(join(this.dir, id + '.json'))
        return true
      } catch (error) {
        // An explicit owner reset may also recover corrupt pins. Only absence is a no-op.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
  }

  observe(command: readonly string[], listed: readonly ListedTool[], complete: boolean, earlierNames: ReadonlySet<string>): { held: HeldTool[]; shadowServers: Map<string, string> } {
    return this.locked(() => {
      const previous = this.read(serverId(command))
      const result = comparePins(previous?.tools ?? null, listed)
      const file = previous ?? { command, tools: result.pins, definitions: dictionary<ListedTool>(), pending: dictionary<ListedTool>() }
      const imitations = shadows(listed, this.others(command))
      const shadowServers = new Map(imitations.map(tool => [tool.name, tool.server]))
      const drift = result.held.filter(tool => !shadowServers.has(tool.name))
      const pending = new Set(drift.map(tool => tool.name))
      let dirty = !previous
      for (const tool of listed) {
        const name = tool.name
        if (pending.has(name)) {
          const waiting = file.pending[name]
          if (!waiting || fingerprint(waiting) !== fingerprint(tool)) {
            file.pending[name] = pinnedDeclaration(tool)
            dirty = true
          }
        } else if (!file.definitions[name] && file.tools[name] === fingerprint(tool)) {
          file.definitions[name] = pinnedDeclaration(tool)
          dirty = true
        }
      }
      const seen = new Set(listed.map(tool => tool.name))
      for (const name of Object.keys(file.pending)) {
        if (!pending.has(name) && (seen.has(name) || (complete && !earlierNames.has(name)))) {
          delete file.pending[name]
          dirty = true
        }
      }
      if (dirty) this.write(file)
      const held = [...imitations.map(tool => ({ name: tool.name, why: 'shadow' as const, imitates: tool.imitates })), ...drift]
      return { held, shadowServers }
    })
  }

  changes(): PinChange[] {
    return this.files().flatMap(id => {
      const file = this.read(id)
      if (!file || !Object.keys(file.pending).length) return []
      const candidates = Object.values(file.pending)
      const held = new Set(shadows(candidates, this.others(file.command)).map(tool => tool.name))
      return candidates.filter(tool => !held.has(tool.name)).map(tool => change(file, tool))
    })
  }

  approveChange(id: string): PinChange | null {
    return this.locked(() => {
      for (const key of this.files()) {
        const file = this.read(key)
        if (!file) continue
        for (const tool of Object.values(file.pending)) {
          const proposed = change(file, tool)
          if (proposed.id !== id) continue
          if (shadows([tool], this.others(file.command)).length) return null
          file.tools[tool.name] = fingerprint(tool)
          file.definitions[tool.name] = tool
          delete file.pending[tool.name]
          this.write(file)
          return proposed
        }
      }
      return null
    })
  }

  others(command: readonly string[]): Array<{ server: string; names: string[] }> {
    return this.files().filter(id => id !== serverId(command)).flatMap(id => {
      const file = this.read(id)
      return file ? [{ server: file.command.join(' '), names: Object.keys(file.tools) }] : []
    })
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir).filter(name => name.endsWith('.json')).sort().map(name => name.slice(0, -5))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private read(id: string): PinFile | null {
    const path = join(this.dir, id + '.json')
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`the MCP pins are unreadable (${path}): ${(error as Error).message}`)
    }
    let file: unknown
    try {
      file = JSON.parse(raw)
    } catch {
      throw new Error(`the MCP pins are corrupted (${path})`)
    }
    if (!record(file) || !Array.isArray(file.command) || !file.command.every(arg => typeof arg === 'string') ||
      serverId(file.command) !== id || !record(file.tools) || !Object.values(file.tools).every(hash => typeof hash === 'string')) {
      throw new Error(`the MCP pins are incompatible (${path})`)
    }
    const tools = dictionary(file.tools as Pins)
    if (file.version === 1) return { command: file.command, tools, definitions: dictionary(), pending: dictionary() }
    if (file.version !== 2 || !declarations(file.definitions) || !declarations(file.pending) ||
      Object.entries(file.definitions).some(([name, tool]) => tools[name] !== fingerprint(tool))) {
      throw new Error(`the MCP pins are incompatible (${path})`)
    }
    return { command: file.command, tools, definitions: dictionary(file.definitions), pending: dictionary(file.pending) }
  }

  private write(file: PinFile): void {
    const path = join(this.dir, serverId(file.command) + '.json')
    const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp'
    try {
      writeFileSync(temp, JSON.stringify({ version: 2, ...file }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temp, path)
    } finally {
      rmSync(temp, { force: true })
    }
  }

  /** A listing, reset and owner decision must never overwrite each other's snapshot. */
  private locked<T>(update: () => T): T {
    makeDirectory(this.dir)
    const lock = join(this.dir, '.writer-lock')
    const wait = new Int32Array(new SharedArrayBuffer(4))
    for (let retry = 0; ; retry++) {
      try {
        mkdirSync(lock, { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Never steal a slow writer's lock. An abandoned lock needs an owner.
        if (retry >= 40) throw new Error(`MCP pins are busy (${lock}). Retry after the writer finishes. For an abandoned lock, see docs/install-mcp.md#recover-an-interrupted-pin-write.`)
        Atomics.wait(wait, 0, 0, 10)
      }
    }
    try {
      return update()
    } finally {
      rmdirSync(lock)
    }
  }
}
