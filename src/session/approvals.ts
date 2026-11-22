import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
const NONCE = /^[0-9a-f]{16}$/u
const INSTANCE = /^[0-9a-f]{64}$/u

/** The approval store and the session sweep remove only these file names. */
export const APPROVAL_FILES = /^[0-9a-f]{16}\.(?:request\.json|request-writing\.[0-9a-f]{16}|approved(?:\.[0-9a-f]{64})?|approval-writing\.[0-9a-f]{16}|used\.[0-9a-f]{64}|taken\.[0-9a-f]{16}|taking\.\d+\.[0-9a-f]{8})$/u

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

interface WaitingRequest extends ShownRequest {
  at: string
  binding: string
  /** Identifies the bytes of the specific question the owner was shown. */
  instance: string
}

interface Grant {
  binding: string
  nonce: string
  instance: string
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
 * The gateway writes one immutable request and the owner publishes a grant
 * scoped to that request. A retry claims the grant by renaming it, then
 * claims the request instance exclusively so concurrent owner approvals
 * for the same question cannot authorize multiple retries.
 */
export class ApprovalStore {
  private readonly dir: string

  constructor(cordonHome: string) {
    this.dir = join(cordonHome, 'approvals')
  }

  pendingPath(id: string): string {
    return join(this.dir, `${checked(id)}.request.json`)
  }

  /** The publication path for the current question. */
  approvedPath(id: string): string {
    const request = this.read(checked(id))
    return request === null ? join(this.dir, `${id}.approved`) : this.grantPath(id, request.instance)
  }

  private grantPath(id: string, instance: string): string {
    return join(this.dir, `${id}.approved.${instance}`)
  }

  private usedPath(id: string, instance: string): string {
    return join(this.dir, `${id}.used.${instance}`)
  }

  takenPath(id: string, nonce: string): string {
    return join(this.dir, `${checked(id)}.taken.${nonce}`)
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
      // Even two requests written in the same millisecond must have
      // distinct identities when an earlier question is retired.
      generation: randomBytes(16).toString('hex'),
      tool: request.tool,
      reason: request.reason,
      args,
      binding,
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(request.call === undefined ? {} : { call: request.call }),
      at: new Date().toISOString(),
    })
    this.sweep()
    // The owner lists final names. Publish a complete private file with
    // an exclusive link so two concurrent writers keep the first question.
    const writing = join(this.dir, `${checked(id)}.request-writing.${randomBytes(8).toString('hex')}`)
    try {
      writeFileSync(writing, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        linkSync(writing, this.pendingPath(id))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A crash after consumption can leave an occupied request path with
        // nothing the owner can approve. Keep any replacement on disk intact.
        if (this.waiting(id) === null) {
          throw new Error(`could not publish approval question ${id} because the existing request is unavailable`)
        }
      }
    } finally {
      rmSync(writing, { force: true })
    }
  }

  /**
   * Publishes the owner's grant for the question they inspected. The optional
   * instance lets the CLI keep its journal and the grant about the same question.
   */
  approve(id: string, expectedInstance?: string): ShownRequest | null {
    const request = this.waiting(id)
    if (request === null || (expectedInstance !== undefined && request.instance !== expectedInstance)) return null

    const { instance, binding, at: _at, ...shown } = request
    const nonce = randomBytes(8).toString('hex')
    const writing = join(this.dir, `${id}.approval-writing.${nonce}`)
    const publication = this.grantPath(id, instance)
    try {
      writeFileSync(writing, `${binding}\n${nonce}\n${instance}`, { mode: 0o600, flag: 'wx' })
      if (this.waiting(id)?.instance !== instance) return null
      // The retry must see a complete grant. The instance in the name also
      // keeps a late owner approval from replacing a renewed question's grant.
      renameSync(writing, publication)
    } finally {
      rmSync(writing, { force: true })
    }
    // A retry may have used exactly this grant while the owner was still
    // publishing it. Only that grant's receipt can distinguish use from expiry.
    if (existsSync(this.takenPath(id, nonce))) return shown
    if (this.read(id)?.instance === instance) {
      const used = this.usedPath(id, instance)
      if (!existsSync(used) || this.readGrant(used)?.nonce === nonce) return shown
    }
    rmSync(publication, { force: true })
    return null
  }

  /** A complete grant for the still-pending question, without consuming it. */
  hasApproval(id: string, expectedInstance?: string): boolean {
    const request = this.waiting(id)
    if (request === null || (expectedInstance !== undefined && request.instance !== expectedInstance)) return false
    const grant = this.readGrant(this.grantPath(id, request.instance))
    return grant !== null && grant.instance === request.instance && grant.binding === request.binding &&
      this.waiting(id)?.instance === request.instance
  }

  private stale(path: string): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > APPROVAL_TTL_MS
    } catch {
      return false
    }
  }

  /**
   * Takes one fresh grant for the current question and context. An unreadable
   * file, expired question or failed claim leaves the call refused.
   */
  take(id: string, binding: string): Taken {
    if (!ID.test(id)) return { taken: false, void: false }
    const request = this.waiting(id)
    if (request === null) return { taken: false, void: false }

    const claimed = join(this.dir, `${id}.taking.${process.pid}.${randomBytes(4).toString('hex')}`)
    try {
      renameSync(this.grantPath(id, request.instance), claimed)
    } catch {
      // No grant, or another retry took it first.
      return { taken: false, void: false }
    }
    try {
      const grant = this.readGrant(claimed)
      if (grant === null || grant.instance !== request.instance || grant.binding !== request.binding) {
        return { taken: false, void: false }
      }

      // A second owner command can publish another grant while this retry
      // is using the first. Claim the question itself before giving effect.
      linkSync(claimed, this.usedPath(id, request.instance))
      if (this.read(id)?.instance !== request.instance) return { taken: false, void: false }

      if (grant.binding !== binding) {
        this.discard(id, request.instance)
        return { taken: false, void: true }
      }
      writeFileSync(this.takenPath(id, grant.nonce), '', { mode: 0o600, flag: 'wx' })
      this.discard(id, request.instance)
      return { taken: true, void: false }
    } catch {
      // Failure to claim or record a take never permits the call.
      return { taken: false, void: false }
    } finally {
      try {
        rmSync(claimed, { force: true })
      } catch {
        // The private claim is never reused and will be swept when stale.
      }
    }
  }

  private readGrant(path: string): Grant | null {
    try {
      const text = readFresh(path)
      if (text === null) return null
      const fields = text.split('\n')
      const [binding, nonce, instance] = fields
      if (fields.length !== 3 || binding === undefined || !BINDING.test(binding) ||
        nonce === undefined || !NONCE.test(nonce) || instance === undefined || !INSTANCE.test(instance)) return null
      return { binding, nonce, instance }
    } catch {
      // Unreadable and already claimed grants count as unavailable.
      return null
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
      const instance = this.read(id)?.instance
      if (instance === undefined) continue
      const context = this.contextOf(id)
      if (this.retire(id, instance)) retired.push({ id, context })
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
      if (!APPROVAL_FILES.test(name)) continue
      if (this.stale(join(this.dir, name))) {
        try {
          unlinkSync(join(this.dir, name))
        } catch {
          // Another process swept it first.
        }
      }
    }
  }

  private retire(id: string, instance: string): boolean {
    if (this.read(id)?.instance !== instance) return false
    try {
      writeFileSync(this.usedPath(id, instance), '', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // A take or another retirement already owns the question.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    this.discard(id, instance)
    return true
  }

  private discard(id: string, instance: string): void {
    try {
      if (this.read(id)?.instance === instance) rmSync(this.pendingPath(id), { force: true })
      rmSync(this.grantPath(id, instance), { force: true })
    } catch {
      // The exclusive marker already voids the question and any remaining
      // grant for it. The stale files can be swept.
    }
  }

  /** Retires a held question when its host timed out or cancelled the call. */
  cancel(id: string, expectedInstance?: string): ShownRequest | null {
    const request = this.waiting(id)
    if (request === null || (expectedInstance !== undefined && request.instance !== expectedInstance)) return null
    return this.retire(id, request.instance) ? request : null
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
      const request = this.waiting(id)
      if (request !== null) {
        const { instance: _instance, ...shown } = request
        result.push({ id, ...shown })
      }
    }
    return result
  }

  /** A waiting request that is still fresh and unused, or null. */
  waiting(id: string): WaitingRequest | null {
    const request = this.read(checked(id))
    return request === null || existsSync(this.usedPath(id, request.instance)) ? null : request
  }

  private read(id: string): WaitingRequest | null {
    try {
      const body = readFresh(this.pendingPath(id))
      if (body === null) return null
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed !== 'object' || parsed === null) return null
      const { tool, reason, at, args, binding, context } = parsed as Record<string, unknown>
      if (typeof tool !== 'string' || typeof reason !== 'string' || typeof at !== 'string') return null
      if (binding !== undefined && (typeof binding !== 'string' || !BINDING.test(binding))) return null
      return {
        tool,
        reason,
        at,
        args: typeof args === 'string' ? args : '',
        binding: binding ?? '',
        instance: createHash('sha256').update(body).digest('hex'),
        ...(isContext(context) ? { context } : {}),
      }
    } catch {
      // Absent or damaged: nothing the owner could be shown, so nothing to approve.
      return null
    }
  }
}

function readFresh(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    // Check the same inode whose bytes are read. The path may already
    // refer to a newer request by the time a different process opens it.
    const stat = fstatSync(fd)
    if (!stat.isFile() || Date.now() - stat.mtimeMs > APPROVAL_TTL_MS) return null
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
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
