import { accessSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadPolicy } from '../../policy/load.js'
import { handle } from './handlers.js'
import { parseEvent, silentOnFailure, type HookEvent, type HookOutput } from './protocol.js'

export function cordonHome(): string {
  return process.env.CORDON_HOME ?? join(homedir(), '.cordon')
}

/**
 * The single point where exceptions are caught in the whole adapter.
 *
 * Synchronous deliberately. A hook that timed out does NOT block the
 * call, that is, hanging equals passing. There must be no asynchrony, no
 * waiting and no network on the hot path.
 *
 * A divergence from the plan: there is one catch, but not one direction of
 * refusal. Event parsing throws nothing by construction, so the event's kind
 * is known BEFORE anything can break, and the direction is chosen by it.
 * Printing a PreToolUse decision in response to a PostToolUse is not allowed:
 * that event has no such field, the harness will silently discard the output,
 * and it will look like a defence that fired — exactly the quiet failure rule
 * 2 protects against.
 */
export function runHook(stdin: string, home: string = cordonHome()): string {
  let event: HookEvent
  try {
    event = parseEvent(stdin)
  } catch (error) {
    // Parsing must not throw at all. If it did throw anyway, the event's kind
    // is unknown, and the strictest possible assumption is what remains.
    return JSON.stringify(deny(`Cordon failure: ${(error as Error).message}`))
  }

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
 * A divergence from the plan: this check was not in it, and without it an
 * unusable home meant a quiet pass rather than a refusal. Session state is
 * the only memory between hook processes: without writes provenance is
 * always empty, so the data axis is dead, PostToolUse marks nothing, and
 * PreToolUse passes everything that fits the profile. From the outside that
 * looks like a working defence. An absent home is not a failure, though: a
 * fresh install is what creates it — the failure is being unable to create it
 * or to write into it.
 */
function ensureUsableHome(home: string): void {
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  accessSync(sessions, constants.W_OK)
}

/**
 * A refusal in the form the event allows.
 *
 * On PostToolUse the tool has already run: there is nothing to forbid and
 * nothing to print — what remains is the absence of a substitution. This is
 * rule 3 in full, and it is the same one `handle` applies inside itself.
 *
 * On MessageDisplay a refusal is forbidden for a different reason: the event
 * decides nothing, and an empty response makes the harness show the source
 * text. See silentOnFailure — the direction of refusal is chosen there, in one
 * place for the whole adapter.
 */
function failure(event: HookEvent, reason: string): HookOutput {
  return silentOnFailure(event) ? {} : deny(reason)
}

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}
