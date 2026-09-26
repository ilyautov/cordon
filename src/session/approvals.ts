import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCall } from '../core/types.js'
import { makeDirectory } from '../core/mkdir.js'

/**
 * How long a request waits for the owner, and how long an approval waits for
 * the retry. An hour: long enough for a person to come back to a terminal,
 * short enough that an approval forgotten on disk does not wait for whatever
 * call happens to match it next week.
 */
export const APPROVAL_TTL_MS = 60 * 60 * 1000

const ID = /^[0-9a-f]{16}$/u

/**
 * The identity of one exact call in one session.
 *
 * The owner approves what they read, and nothing else may pass under that
 * approval: a different recipient, one more argument, the same call in
 * another session. The arguments are serialized with sorted keys, so the
 * model reordering them is still the same call, and as JSON, so nesting
 * cannot be forged by joining strings.
 */
export function approvalId(sessionId: string, call: ToolCall): string {
  const canonical = JSON.stringify([sessionId, call.tool, sorted(call.args ?? {})])
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) result[key] = sorted((value as Record<string, unknown>)[key])
  return result
}

export interface ApprovalRequest {
  tool: string
  reason: string
}

export interface PendingApproval extends ApprovalRequest {
  id: string
  at: string
}

/**
 * One-time approvals for transports with no one to ask: the MCP gateway and
 * the LangChain middleware, where the interactive mode's question used to
 * become a refusal with no way forward.
 *
 * Two files per call, and never a shared one. The gateway writes the request,
 * `cordon approve` writes the approval from another process, and the retry
 * consumes it by deleting it. With one file per state no process rewrites
 * another's writing, and deleting is the lock: of two retries racing for one
 * approval, exactly one unlink succeeds.
 */
export class ApprovalStore {
  private readonly dir: string

  constructor(cordonHome: string) {
    this.dir = join(cordonHome, 'approvals')
  }

  pendingPath(id: string): string {
    return join(this.dir, `${checked(id)}.request.json`)
  }

  approvedPath(id: string): string {
    return join(this.dir, `${checked(id)}.approved`)
  }

  /** Records that a call waits for the owner. A request already waiting is left as it is. */
  request(id: string, request: ApprovalRequest): void {
    makeDirectory(this.dir, 0o700)
    const body = JSON.stringify({ tool: request.tool, reason: request.reason, at: new Date().toISOString() })
    try {
      writeFileSync(this.pendingPath(id), body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      // Already waiting: the first request stands, and its age with it. Any
      // other failure propagates; the caller's refusal is issued either way.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /**
   * The owner's approval of a waiting request, or null when there is none to
   * approve. Returns what was approved, so the owner sees it said back.
   */
  approve(id: string): ApprovalRequest | null {
    const request = this.read(id)
    if (request === null) return null
    writeFileSync(this.approvedPath(id), '', { mode: 0o600 })
    return { tool: request.tool, reason: request.reason }
  }

  /**
   * Whether an approval for this call is waiting, taking it if so.
   *
   * Every failure answers false, and false is a refusal: an unreadable store
   * or an approval that is not there never lets a call through.
   */
  consume(id: string): boolean {
    if (!ID.test(id)) return false
    try {
      const fresh = Date.now() - statSync(this.approvedPath(id)).mtimeMs <= APPROVAL_TTL_MS
      unlinkSync(this.approvedPath(id))
      try {
        unlinkSync(this.pendingPath(id))
      } catch {
        // The request is gone already; the approval was the thing to take.
      }
      return fresh
    } catch {
      // No approval, or another retry took it first: the call is refused.
      return false
    }
  }

  /** The requests still waiting, for `cordon approve` with no id. */
  pending(): PendingApproval[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const result: PendingApproval[] = []
    for (const name of names) {
      const id = name.replace(/\.request\.json$/u, '')
      if (id === name || !ID.test(id)) continue
      const request = this.read(id)
      if (request !== null) result.push({ id, ...request })
    }
    return result
  }

  /** A waiting request that is still fresh, or null. */
  private read(id: string): (ApprovalRequest & { at: string }) | null {
    const path = this.pendingPath(id)
    try {
      if (Date.now() - statSync(path).mtimeMs > APPROVAL_TTL_MS) return null
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return null
      const { tool, reason, at } = parsed as Record<string, unknown>
      if (typeof tool !== 'string' || typeof reason !== 'string' || typeof at !== 'string') return null
      return { tool, reason, at }
    } catch {
      // Absent or damaged: nothing the owner could be shown, so nothing to approve.
      return null
    }
  }
}

function checked(id: string): string {
  if (!ID.test(id)) throw new Error(`not an approval id: ${JSON.stringify(id).slice(0, 40)}`)
  return id
}
