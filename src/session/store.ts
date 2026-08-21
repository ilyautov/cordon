import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeDirectory } from '../core/mkdir.js'
import type { EffectClass } from '../core/types.js'
import { TaintStore } from '../provenance/store.js'

export interface SessionState {
  turn: number
  taint: TaintStore
  /**
   * The hidden layer could not be stripped from a tool result because the
   * output's shape is unfamiliar. An absent field means "no mark".
   */
  unredacted?: boolean
  /**
   * The narrowing requested by the user with a `cordon: scope` directive.
   *
   * What lies on disk is the requested set, NOT an issued certificate. The
   * difference matters: the certificate is issued afresh in every process,
   * and a stored narrowing is applied to it through `narrow`, that is, by
   * intersection only. The state file can take rights away and cannot add
   * them.
   *
   * An absent field means "no narrowing was asked for", that is, null.
   */
  directive?: EffectClass[] | null
}

/**
 * The message text accumulated from the display event's deltas.
 *
 * Exactly one message is kept: a delta with a different identifier means the
 * previous one has ended. Otherwise the accumulated text would grow for the
 * whole session.
 *
 * It lives in its own file and NOT in the session state, and that is not a
 * matter of tidiness. The state is written whole: to append to the
 * accumulated text it would have to be read, extended and written back
 * together with the provenance store. Every hook event is a separate process,
 * and a neighbouring process's write landing between the read and the write
 * would be overwritten by the version read before it. Lost provenance is
 * quiet: a tainted argument will then simply pass through the gate as clean.
 * The output axis blocks nothing, and trading the data axis's memory for it
 * is not allowed.
 */
export interface SessionDraft {
  messageId: string
  text: string
}

/** The effect classes we agree to read from the state file. */
const EFFECTS: ReadonlySet<string> = new Set<EffectClass>([
  'read', 'summarize', 'create', 'update', 'delete',
  'export', 'network-egress', 'financial', 'exec',
])

/** The accumulation limit, the same as the analysis limit on the output axis. */
const MAX_DRAFT = 200_000

const VERSION = 4

/**
 * The versions we can read. Earlier ones are read on a par with the current
 * one rather than rejected: each differs by the absence of one field, and
 * that means exactly absence — neither a mark nor a narrowing was asked for.
 * Refusing to read a previous version's state would turn a Cordon upgrade
 * into a permanently refusing session: nobody would rewrite the file, because
 * things never get as far as writing.
 *
 * The version was not lowered when the accumulated answer text moved into its
 * own file. Version 4 files with a `draft` field already lie on disks, they
 * must still be readable, and the field in them is simply not read: lowering
 * the version would force them to be rejected, that is, would fix a quiet
 * loss with a loud refusal.
 */
const READABLE: ReadonlySet<number> = new Set([1, 2, 3, VERSION])

/**
 * The session state on disk.
 *
 * It exists because a harness hook is a separate process per event: the one
 * that read a tool result and the one that checks the next call share no
 * memory. Without disk the data axis is dead on a real harness:
 * observe writes into the void, and the gate always sees clean arguments.
 */
export class SessionStore {
  constructor(private readonly cordonHome: string) {}

  load(sessionId: string): SessionState {
    const path = this.pathFor(sessionId)

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { turn: 0, taint: new TaintStore(), unredacted: false, directive: null }
      }
      throw new Error(`the session state ${shown(sessionId)} is unreadable: ${(error as Error).message}`)
    }

    // A broken state is a refusal. Silently returning an empty store means
    // reporting that nothing untrusted was read, that is, handing the
    // attacker the most permissive state for the price of corrupting one
    // file.
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`the session state ${shown(sessionId)} is corrupted: ${(error as Error).message}`)
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`the session state ${shown(sessionId)} is incompatible`)
    }
    // The fields are read only as own properties: the file comes from
    // outside, and a lookup through the prototype would return a member of
    // Object.prototype instead of an absent field.
    const data = parsed as Record<string, unknown>
    const version = Object.hasOwn(data, 'version') ? data['version'] : undefined
    const turn = Object.hasOwn(data, 'turn') ? data['turn'] : undefined
    const taint = Object.hasOwn(data, 'taint') ? data['taint'] : undefined
    const unredacted = Object.hasOwn(data, 'unredacted') ? data['unredacted'] : undefined
    const directive = Object.hasOwn(data, 'directive') ? data['directive'] : undefined
    if (
      typeof version !== 'number' || !READABLE.has(version) ||
      typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0
    ) {
      throw new Error(`the session state ${shown(sessionId)} is incompatible`)
    }
    // A mark that is not a boolean means a corrupted file. Coercing it to
    // false means lifting an escalation by corrupting one field, that is,
    // handing the attacker the most permissive state.
    if (unredacted !== undefined && typeof unredacted !== 'boolean') {
      throw new Error(`the session state ${shown(sessionId)} is incompatible`)
    }
    // The directive's shape is validated rather than filtered. Filtering
    // would narrow too (`narrow` intersects), but then a corrupted file would
    // look like a working one, and a corrupted file must be audible. An
    // absent field is not an error, though: a live session's old state must
    // not become permanently refusing because Cordon was upgraded.
    if (
      directive !== undefined && directive !== null &&
      (!Array.isArray(directive) || directive.some((item) => typeof item !== 'string' || !EFFECTS.has(item)))
    ) {
      throw new Error(`the session state ${shown(sessionId)} is incompatible`)
    }

    return {
      turn,
      taint: TaintStore.fromJSON(taint),
      unredacted: unredacted === true,
      directive: Array.isArray(directive) ? (directive as EffectClass[]) : null,
    }
  }

  save(sessionId: string, state: SessionState): void {
    const path = this.pathFor(sessionId)
    const body = JSON.stringify({
      version: VERSION,
      turn: state.turn,
      taint: state.taint.toJSON(),
      unredacted: state.unredacted === true,
      directive: state.directive ?? null,
    })

    atomicWrite(join(this.cordonHome, 'sessions'), path, body)
  }

  /**
   * The accumulated text of the message being displayed.
   *
   * Never throws: a malformed draft is the absence of a draft. Only the
   * display event reads it, where an error would cost the human the sight of
   * the model's answer while protecting nothing. A draft decides nothing, it
   * only describes. The session state still throws on everything.
   */
  loadDraft(sessionId: string): SessionDraft | undefined {
    let raw: string
    try {
      raw = readFileSync(this.draftPathFor(sessionId), 'utf8')
    } catch {
      return undefined
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    return readDraft(parsed)
  }

  saveDraft(sessionId: string, draft: SessionDraft): void {
    // Truncated on write as well: the file must not balloon from one long
    // answer, even if we were called bypassing the hook.
    const body = JSON.stringify({ messageId: draft.messageId, text: draft.text.slice(0, MAX_DRAFT) })
    atomicWrite(join(this.cordonHome, 'drafts'), this.draftPathFor(sessionId), body)
  }

  /**
   * Erases the accumulated text. Does not throw: the message has already
   * ended, and a failed deletion must not take the footer away from the
   * human. A leftover file is harmless — accumulated text is taken only for a
   * matching message identifier, and the next message will overwrite it.
   */
  clearDraft(sessionId: string): void {
    try {
      rmSync(this.draftPathFor(sessionId), { force: true })
    } catch {
      // Deliberately silent: see the method's description.
    }
  }

  private pathFor(sessionId: string): string {
    return join(this.cordonHome, 'sessions', `${safeName(sessionId)}.json`)
  }

  /**
   * The draft file lies in its own directory rather than next to the state.
   *
   * The name is built the same safe way: the session identifier comes from
   * the harness, and the filtering plus hash is needed here just the same. A
   * separate directory was chosen so that the contents of `sessions/` stay
   * exactly session states: listing that directory must not run into files
   * that are not state.
   */
  private draftPathFor(sessionId: string): string {
    return join(this.cordonHome, 'drafts', `${safeName(sessionId)}.json`)
  }
}

/**
 * Writing a file by replacement.
 *
 * Mode 0700 on the directory: provenance atoms hold pieces of what was read,
 * including links and identifiers, and a draft holds the model's answer text.
 * There is no reason for shared access to them.
 *
 * Writing through a temporary file and renaming: an interrupted process must
 * not leave behind truncated JSON that turns into a denial of service on the
 * next run.
 */
function atomicWrite(dir: string, path: string, body: string): void {
  makeDirectory(dir)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

/**
 * Parses the accumulated message text.
 *
 * Malformed accumulated text is the absence of accumulated text, not a
 * refusal: see loadDraft.
 */
function readDraft(raw: unknown): SessionDraft | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  // The fields are read as own properties: the file comes from outside, and a
  // lookup through the prototype would return a member of Object.prototype
  // instead of an absent field.
  const data = raw as Record<string, unknown>
  const messageId = Object.hasOwn(data, 'messageId') ? data['messageId'] : undefined
  const text = Object.hasOwn(data, 'text') ? data['text'] : undefined
  if (typeof messageId !== 'string' || messageId === '') return undefined
  if (typeof text !== 'string') return undefined
  return { messageId, text: text.slice(0, MAX_DRAFT) }
}

/** The identifier in an error message is truncated: it came from outside. */
function shown(sessionId: string): string {
  return sessionId.length > 64 ? `${sessionId.slice(0, 64)}…` : sessionId
}

/**
 * The state file's name for a session identifier.
 *
 * The identifier comes from the harness, that is, from outside. Substituting
 * it into a path as-is is not allowed: a value like "../../policy" would
 * overwrite Cordon's config, going around self-protection from the side where
 * it is not checked.
 *
 * The dot is dropped from the allowed character set entirely, not only at the
 * start. Filtering that keeps dots turns "../../policy" into a name like
 * "__.._policy": it no longer leads outward, but ".." inside the name means
 * the rule rests on the absence of a separator alone. Removing the dot is
 * cheaper than proving each time that the remaining combination is safe.
 *
 * Exported because the sweep uses the same rule: it needs to recognize the
 * files of the currently running session so as not to delete them. A second
 * copy of the rule would diverge from the first at the very first fix.
 *
 * The tail is a hash of the original value. Without it the filtering glues
 * different identifiers into one name: "a/b" and "a_b" would give one file,
 * and the second session would overwrite the first one's provenance.
 * Overwritten provenance is an empty store, that is, exactly the permissive
 * state the attacker is after.
 */
export function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 64)
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 16)
  return cleaned === '' ? digest : `${cleaned}-${digest}`
}
