import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCall } from '../core/types.js'
import { makeDirectory } from '../core/mkdir.js'
import { canonical, sorted } from '../core/canonical.js'

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

export { canonical }

export interface ApprovalRequest {
  tool: string
  reason: string
  /** The call's arguments, so the owner approves what they can read. */
  args?: unknown
  /**
   * The context the question was asked in, hashed: the call, the rule, the
   * exposure mark and the policy. An approval holds only under the same one.
   */
  binding?: string
  /** The same context in words, so a voided approval can say what changed. */
  context?: ApprovalContext
  /** The call alone, `approvalId`: what ties the questions about one call together. */
  call?: string
}

export interface ApprovalContext {
  rule: string
  /** The untrusted source the session had read, or null. */
  exposure: string | null
  policy: string
  /** The user turn the question was asked in. */
  turn: number
  /** How many untrusted results the session had read. */
  reads: number
}

/** What a retry found: the approval taken, or voided by a changed context. */
export interface Taken {
  taken: boolean
  void: boolean
}

const BINDING = /^(?:[0-9a-f]{64})?$/u

/** A request as the owner is shown it: the arguments already serialized. */
export interface ShownRequest {
  tool: string
  reason: string
  args: string
  /** What the question was asked under, when the request recorded it. */
  context?: ApprovalContext
}

export interface PendingApproval extends ShownRequest {
  id: string
  at: string
}

/**
 * How much of the arguments a terminal listing shows. Only the listing is
 * cut: the request file keeps every argument, and a request longer than this
 * is not approved until the owner says they read the file.
 */
export const MAX_SHOWN_ARGS = 4000

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
    // Whole, never cut. Keys are sorted, so a long body pushes whatever sorts
    // after it (a "to", say) past any cut: the owner would approve a
    // recipient they were never shown.
    const args = canonical(request.args ?? {})
    const binding = request.binding ?? ''
    if (!BINDING.test(binding)) throw new Error('an approval binding is a sha256 in hex')
    const body = JSON.stringify({
      tool: request.tool,
      reason: request.reason,
      args,
      binding,
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(request.call === undefined ? {} : { call: request.call }),
      at: new Date().toISOString(),
    })
    // A request past its hour can no longer be approved, so it is replaced
    // rather than left to block the id forever; an approval left over from it
    // goes too, so the renewal cannot revive it.
    this.sweep()
    if (this.stale(this.pendingPath(id))) {
      for (const path of [this.pendingPath(id), this.approvedPath(id)]) {
        try {
          unlinkSync(path)
        } catch {
          // Already gone: nothing to retire.
        }
      }
    }
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
  approve(id: string): ShownRequest | null {
    const request = this.read(id)
    if (request === null) return null
    // The approval carries the binding it was given under, so a retry in a
    // different context cannot take it.
    writeFileSync(this.approvedPath(id), request.binding, { mode: 0o600 })
    // Retired while this ran: the approval would be void anyway, and the
    // owner must not read "approved once" about a question that is gone.
    if (this.read(id) === null) {
      this.retire(id)
      return null
    }
    return { tool: request.tool, reason: request.reason, args: request.args, ...(request.context === undefined ? {} : { context: request.context }) }
  }

  /** Takes back an approval given a moment ago; the question keeps waiting. */
  withdraw(id: string): void {
    try {
      unlinkSync(this.approvedPath(id))
    } catch (error) {
      // Gone already is withdrawn. Anything else must not leave an approval
      // standing that the owner was told was not given.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private stale(path: string): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > APPROVAL_TTL_MS
    } catch {
      return false
    }
  }

  /**
   * Whether an approval for this call is waiting, taking it if so.
   *
   * Every failure answers false, and false is a refusal: an unreadable store
   * or an approval that is not there never lets a call through.
   */
  /**
   * Takes the approval for this call if it was given under this binding.
   *
   * Every failure answers not taken, and not taken is a refusal. An approval
   * under another binding is voided, with its request, so the next refusal
   * asks the question afresh and the owner sees the current one.
   */
  take(id: string, binding: string): Taken {
    if (!ID.test(id)) return { taken: false, void: false }
    try {
      const path = this.approvedPath(id)
      const fresh = Date.now() - statSync(path).mtimeMs <= APPROVAL_TTL_MS
      const given = readFileSync(path, 'utf8')
      // An approval is only as good as its question. One whose question was
      // retired, by a retry under a newer context racing the owner's
      // `approve`, is void however it got written (Codex).
      if (!existsSync(this.pendingPath(id))) {
        this.retire(id)
        return { taken: false, void: false }
      }
      if (fresh && given !== binding) {
        this.retire(id)
        return { taken: false, void: true }
      }
      unlinkSync(path)
      try {
        unlinkSync(this.pendingPath(id))
      } catch {
        // The request is gone already; the approval was the thing to take.
      }
      return { taken: fresh, void: false }
    } catch {
      // No approval, or another retry took it first: the call is refused.
      return { taken: false, void: false }
    }
  }

  /**
   * Retires every other question about the same call: asked under an earlier
   * context, with any approval given to it. Returns what was retired, so the
   * journal can say what changed. A request that cannot be read is left: it
   * can be neither approved nor taken, and it expires within the hour.
   */
  retireOthers(call: string, keep: string): Array<{ id: string; context: ApprovalContext | null }> {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const retired: Array<{ id: string; context: ApprovalContext | null }> = []
    for (const name of names) {
      const id = name.replace(/\.request\.json$/u, '')
      if (id === name || id === keep || !ID.test(id)) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(readFileSync(this.pendingPath(id), 'utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed?.call !== call) continue
      retired.push({ id, context: this.contextOf(id) })
      this.retire(id)
    }
    return retired
  }

  /** A waiting request's context in words, for saying what changed. */
  contextOf(id: string): ApprovalContext | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.pendingPath(checked(id)), 'utf8'))
      const context = (parsed as Record<string, unknown> | null)?.context
      return isContext(context) ? context : null
    } catch {
      return null
    }
  }


  /**
   * Removes questions and approvals past their hour. Read-time checks already
   * ignore them; without this an agent steered into many distinct questions
   * leaves a file per question behind, and every listing reads them all
   * (Kimi).
   */
  private sweep(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const id = name.replace(/\.(?:request\.json|approved)$/u, '')
      if (id === name || !ID.test(id)) continue
      if (this.stale(join(this.dir, name))) {
        try {
          unlinkSync(join(this.dir, name))
        } catch {
          // Another process swept it first.
        }
      }
    }
  }

  private retire(id: string): void {
    for (const path of [this.pendingPath(id), this.approvedPath(id)]) {
      try {
        unlinkSync(path)
      } catch {
        // Already gone: nothing to retire.
      }
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
  waiting(id: string): (ShownRequest & { at: string; binding: string }) | null {
    return this.read(checked(id))
  }

  private read(id: string): (ShownRequest & { at: string; binding: string }) | null {
    const path = this.pendingPath(id)
    try {
      if (Date.now() - statSync(path).mtimeMs > APPROVAL_TTL_MS) return null
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return null
      const { tool, reason, at, args, binding, context } = parsed as Record<string, unknown>
      if (typeof tool !== 'string' || typeof reason !== 'string' || typeof at !== 'string') return null
      return {
        tool,
        reason,
        at,
        args: typeof args === 'string' ? args : '',
        binding: typeof binding === 'string' ? binding : '',
        ...(isContext(context) ? { context } : {}),
      }
    } catch {
      // Absent or damaged: nothing the owner could be shown, so nothing to approve.
      return null
    }
  }
}

function isContext(value: unknown): value is ApprovalContext {
  if (typeof value !== 'object' || value === null) return false
  const { rule, exposure, policy, turn, reads } = value as Record<string, unknown>
  return typeof rule === 'string' && (exposure === null || typeof exposure === 'string') && typeof policy === 'string' &&
    typeof turn === 'number' && typeof reads === 'number'
}

function checked(id: string): string {
  if (!ID.test(id)) throw new Error(`not an approval id: ${JSON.stringify(id).slice(0, 40)}`)
  return id
}
