import { accessSync, constants, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPolicy } from '../../policy/load.js'
import { cordonHome } from '../claude-code/main.js'
import { handle, silentOnFailure } from './handlers.js'
import { parseEvent, type HookEvent, type HookOutput } from './protocol.js'

/**
 * The single point where exceptions are caught in the whole adapter.
 *
 * Synchronous deliberately, and stricter than on the first harness. There a
 * pass came from a `PreToolUse` timeout alone; here it comes from ANY hook
 * failure — a crash, garbage on the output, expired time — and Gemini's
 * configuration has no "this hook is mandatory" flag at all (§9.2). So every
 * path out of here must end in a printed decision.
 */
export function runHook(stdin: string, home: string = cordonHome()): string {
  const event = parseEvent(stdin)

  try {
    ensureUsableHome(home)
    const policy = loadPolicy(home)
    return JSON.stringify(handle(event, { policy, cordonHome: home }))
  } catch (error) {
    return JSON.stringify(failure(event, `Cordon failure: ${(error as Error).message}`))
  }
}

/**
 * Checks that Cordon's home is usable for writing session state.
 *
 * Session state is the only memory between hook processes: without writes
 * provenance is always empty, the data axis is dead, and from the outside
 * that looks like a working defence. An absent home is not a failure, though
 * — a fresh install is what creates it.
 */
function ensureUsableHome(home: string): void {
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  accessSync(sessions, constants.W_OK)
}

/**
 * A refusal in the form the event allows.
 *
 * After a tool call and at the end of a turn there is nothing left to forbid:
 * these events have no decision, and the harness will silently discard a
 * `decision` in them. It would look like a defence that fired, that is, it
 * would be the very quiet failure everything else is written against.
 */
function failure(event: HookEvent, reason: string): HookOutput {
  return silentOnFailure(event) ? {} : { decision: 'deny', reason }
}
