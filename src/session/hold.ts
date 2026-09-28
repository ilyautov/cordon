import { SessionStore, noteRead } from './store.js'

/**
 * Marks the session the way a result of unknown shape does, straight through
 * the store: the failure may be the policy itself, and the core cannot come
 * up without one (Codex, reviewing the connectors). Whether the hold was
 * written is returned: a hold that is not on disk is not a hold.
 */
export function holdSession(cordonHome: string, sessionId: string): boolean {
  // Retried with a short pause: a file locked for a moment (an antivirus on
  // Windows, EBUSY) cost the hold on the first attempt, and once the lock
  // cleared nothing on disk said the session was held. The pauses add up to
  // well under the hook's timeout, since a hung hook lets the call through.
  for (const pause of RETRY_PAUSES_MS) {
    if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause)
    try {
      const store = new SessionStore(cordonHome)
      const state = store.load(sessionId)
      // A new read as well, as markUnredacted counts one: an approval is bound
      // to the reads so far, and one given before this result must not be
      // spendable after it (Codex).
      store.save(sessionId, { ...state, unredacted: true, readIds: noteRead(state.readIds ?? []) })
      return true
    } catch {
      // Tried again below. If every attempt fails, the store cannot be read
      // or written; while that lasts the core lets nothing through
      // (Cordon.judge writes before any allow). If it passes before the next
      // call, the hold is gone and nothing on disk can say otherwise, so the
      // caller does not promise one (Codex).
    }
  }
  return false
}

const RETRY_PAUSES_MS = [0, 50, 150, 400]
