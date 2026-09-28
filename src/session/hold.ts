import { SessionStore, noteRead } from './store.js'

/**
 * Marks the session the way a result of unknown shape does, straight through
 * the store: the failure may be the policy itself, and the core cannot come
 * up without one (Codex, reviewing the connectors). Whether the hold was
 * written is returned: a hold that is not on disk is not a hold.
 */
export function holdSession(cordonHome: string, sessionId: string): boolean {
  try {
    const store = new SessionStore(cordonHome)
    const state = store.load(sessionId)
    // A new read as well, as markUnredacted counts one: an approval is bound
    // to the reads so far, and one given before this result must not be
    // spendable after it (Codex).
    store.save(sessionId, { ...state, unredacted: true, readIds: noteRead(state.readIds ?? []) })
    return true
  } catch {
    // The store cannot be read or written. While that lasts, the core lets
    // nothing through (Cordon.judge writes before any allow). If it passes
    // before the next call, the hold is gone and nothing on disk can say
    // otherwise, so the caller does not promise one (Codex).
    return false
  }
}
