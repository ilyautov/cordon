import { lstatSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { safeName } from './store.js'

/**
 * The lifetime of a session's state.
 *
 * A day. A harness session is one conversation, and a conversation with no
 * event in a day has ended. A shorter lifetime is dangerous rather than tidy:
 * an erased state is empty provenance and a lifted certificate narrowing,
 * that is, exactly the permissive state an injection is after. A day was
 * chosen to cover the most common live gap — "closed the laptop in the
 * evening, came back to the same conversation in the morning".
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The lifetime of the accumulated answer text.
 *
 * An hour. A draft lives within ONE answer of the model: from the first delta
 * to the final one, that is, minutes. Anything older than an hour is an
 * interrupted message whose final delta will never arrive — a file of up to
 * 200 KB that nobody will ever read. The lifetime is an order of magnitude
 * shorter than the session's deliberately: a draft decides nothing, and
 * losing it costs the human one footer under an answer at worst, not a
 * weakened defence.
 */
export const DRAFT_TTL_MS = 60 * 60 * 1000

/**
 * How often to look into the directories at all.
 *
 * An hour. Listing a directory on every event would break the rule that the hot
 * path must be fast, because a hook timeout on this harness does NOT block
 * the call, and the only defence against a timeout is speed. Checking the
 * timestamp nearby costs one lstat, a full pass costs thousands.
 */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * How many files are considered in a single pass.
 *
 * The limit exists so that the sweep has a worst case at all: without it a
 * directory that swelled while Cordon was a version without a sweep would
 * give one arbitrarily long pass. The remainder is cleaned up by the next
 * pass an hour later — there is no hurry.
 *
 * The limit is per directory, so a pass makes up to 10000 deletions. By
 * measurement a deletion costs about 0.09 ms per file, so the worst pass is
 * on the order of a second — against a five-second event timeout, and with
 * the turn's state already written to disk by that point.
 */
export const SWEEP_BUDGET = 5000

/** The name of the last-sweep mark. It lies in Cordon's home, not among the states. */
export const SWEEP_MARK = 'last-sweep'

/**
 * The names the sweep recognizes as its own.
 *
 * Exactly what `safeName` produces: a filtered identifier of up to 64
 * characters, a dash, sixteen hash digits. Then, for a session state, the
 * piece written by one process — sixteen hexadecimal digits of its own. Plus
 * the temporary-file tail left behind by an interrupted atomic write.
 *
 * Checking the name is self-protection rather than tidiness: `sessions/` may
 * hold anything a human or somebody else put there, and we agree to delete
 * from it only what we certainly wrote ourselves. A dot is allowed in the
 * pattern only before the known tails, so ".." will not pass as a name.
 */
const OURS = /^[A-Za-z0-9_-]{1,81}(?:\.[a-f0-9]{1,32})?\.json(?:\.\d{1,10}\.tmp)?$/u

/**
 * Cleans up session states and drafts whose time has run out.
 *
 * Cordon has no daemon and must not have one, so the sweep runs alongside, in
 * an already existing flow of events. One moment was chosen: the user's
 * message, and only after this turn's state has already been written. There
 * are two reasons. First, the event is rare — once per message rather than
 * once per tool call. Second, on `PreToolUse` a delay is a missed call, since
 * a hook that timed out does not block it, while on the user's message
 * a delay is a delay and nothing more.
 *
 * Never throws. A failed sweep — no permissions, the file vanished between
 * lstat and deletion, the directory is unavailable — has nothing to do with
 * the defence, and turning it into a refusal would mean breaking the work for
 * the sake of order on disk. Not to be confused with reading state: there a
 * refusal is mandatory and stays as it was.
 *
 * @param keepSessionId the session running right now: its files are left
 *   alone at any age. The case is not made up — state is not written on every
 *   event, and a long conversation with no write in a day would leave a live
 *   session's file older than the lifetime. Erasing it means starting the
 *   next call with empty provenance.
 */
export function sweep(cordonHome: string, keepSessionId: string, now: number = Date.now()): void {
  try {
    if (!due(cordonHome, now)) return
    // The mark is set BEFORE the sweep: two processes that looked in here at
    // the same time must not both walk the directory, and a pass that somehow
    // did not run to the end must not repeat on every event.
    mark(cordonHome)

    // The name without a tail: a session's state is several files now, one
    // per process that wrote it, and all of them belong to the session that
    // is running.
    const keep = safeName(keepSessionId)
    sweepDir(join(cordonHome, 'sessions'), SESSION_TTL_MS, keep, now)
    sweepDir(join(cordonHome, 'drafts'), DRAFT_TTL_MS, keep, now)
  } catch {
    // Deliberately silent: see the function's description.
  }
}

/**
 * Whether it is time to sweep.
 *
 * No mark means yes: this is either the first sweep or a home we cannot write
 * to, and in both cases one pass per hour will not make things worse.
 *
 * The age is taken as an absolute value rather than as "less than zero means
 * time". A mark from the future really does mean "time": otherwise a clock
 * turned back would cancel the sweep until time catches up with what was
 * written. But "from the future" starts here at a whole interval, and that is
 * not a just-in-case margin. `mtimeMs` is fractional and `Date.now()` is
 * rounded down, so a mark just written routinely ends up ahead of the current
 * time by a fraction of a millisecond. A "less than zero" check caught that
 * on every second sweep in a row, that is, cancelled the rate limit entirely.
 */
function due(cordonHome: string, now: number): boolean {
  try {
    const age = now - lstatSync(join(cordonHome, SWEEP_MARK)).mtimeMs
    return Math.abs(age) >= SWEEP_INTERVAL_MS
  } catch {
    return true
  }
}

/** The mark is an empty file: the meaning is in its modification time, not its content. */
function mark(cordonHome: string): void {
  try {
    writeFileSync(join(cordonHome, SWEEP_MARK), '', { encoding: 'utf8', mode: 0o600 })
  } catch {
    // A read-only home. That does not make the sweep harmful, it will just
    // run more often than needed.
  }
}

/**
 * Walks one directory.
 *
 * Symbolic links are resolved nowhere: neither the directory itself nor the
 * entries in it. A link named like one of our state files is the first thing
 * an injection will come up with once it can write into `sessions/`, and
 * resolving it would turn the sweep into the deletion of an arbitrary file on
 * disk. So only real files are deleted, and everything else — links,
 * directories, sockets — is skipped. A directory replaced by a link is not
 * swept at all.
 *
 * The check and the deletion are separated in time, and a file can be
 * replaced by a link in between. That is no hole: `rmSync` without
 * `recursive` removes the directory entry itself rather than what it points
 * at, so even a stale check ends in deleting a link, not somebody else's
 * file.
 */
function sweepDir(dir: string, ttl: number, keep: string, now: number): void {
  let entries: Dirent[]
  try {
    // lstat rather than stat: a `sessions` replaced by a link pointing
    // outward is not our directory, and we will not list it.
    if (!lstatSync(dir).isDirectory()) return
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  let budget = SWEEP_BUDGET
  for (const entry of entries) {
    const name = entry.name
    if (!entry.isFile() || !OURS.test(name)) continue
    // The currently running session's files and their abandoned temporary
    // tails. The digest inside `keep` is sixteen characters of a hash of the
    // whole identifier, so a prefix cannot belong to another session.
    if (name.startsWith(`${keep}.`)) continue

    // The budget is spent only on our own. Otherwise five thousand foreign
    // files dropped into the directory would cancel the sweep entirely
    // without ever reaching ours: checking a name is cheap, fetching metadata
    // is expensive.
    if (budget <= 0) return
    budget -= 1

    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile()) continue
      if (now - stat.mtimeMs < ttl) continue
      rmSync(path, { force: true })
    } catch {
      // The file vanished between the check and the deletion, or permissions
      // were insufficient. Neither is our business: move on.
    }
  }
}
