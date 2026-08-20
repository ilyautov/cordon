import type { Decision, PresenceMode, ToolCall } from '../../core/types.js'

export type HookEvent =
  | { kind: 'PreToolUse'; sessionId: string; call: ToolCall }
  | { kind: 'PostToolUse'; sessionId: string; call: ToolCall; response: unknown }
  | { kind: 'UserPromptSubmit'; sessionId: string; prompt: string }
  | { kind: 'MessageDisplay'; sessionId: string; messageId: string; final: boolean; delta: string }
  | { kind: 'ignored'; sessionId: string }
  | {
      kind: 'unparsable'
      sessionId: string
      reason: string
      /**
       * A refusal on this event will protect nothing, because the event
       * decides nothing. Set only for `MessageDisplay`: there the hook's
       * output changes only what the human sees on screen, and a `deny` in
       * response to an unparsed delta would cost the human the sight of the
       * model's answer without closing a single call.
       */
      silent?: boolean
    }

export interface HookOutput {
  /**
   * Shown to the human in the transcript and NOT returned to the model. A
   * field common to any hook event, unrelated to the decision.
   *
   * Needed where Cordon found something but decided nothing: a hidden layer in
   * a file that was read is neither substituted nor escalated, and staying
   * silent about it is not allowed. Note: the text here comes from an
   * untrusted source, and it is defanged in `output/report.ts`, not here.
   */
  systemMessage?: string
  hookSpecificOutput?: {
    hookEventName: string
    permissionDecision?: 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
    updatedToolOutput?: unknown
    /**
     * Replaces the delta displayed to the human. It changes neither the
     * model's context nor the transcript — that is the whole point of the
     * field: a mark that came back into the context would become the carrier
     * of the injection on the next turn.
     */
    displayContent?: string
  }
}

/**
 * Parses a harness event.
 *
 * Not a single field here is trusted: the JSON arrives on stdin, and an event
 * with a field of the wrong shape is not exotic but the first thing an
 * attacker will try. So parsing throws nothing — it returns either a parsed
 * event or a refusal to parse, which the handler turns into a deny. An
 * exception in the middle of a hook is worse: the harness reads a crashed
 * hook as "let it through".
 */
export function parseEvent(stdin: string): HookEvent {
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(stdin)
    if (!isRecord(parsed)) return { kind: 'unparsable', sessionId: 'default', reason: 'the event is not an object' }
    raw = parsed
  } catch {
    return { kind: 'unparsable', sessionId: 'default', reason: 'the event does not parse as JSON' }
  }

  const rawSession = field(raw, 'session_id')
  const sessionId = typeof rawSession === 'string' && rawSession !== '' ? rawSession : 'default'
  const name = field(raw, 'hook_event_name')

  if (name === 'UserPromptSubmit') {
    const prompt = field(raw, 'prompt')
    // A prompt that is not a string is not a user message. Coercing an object
    // to "[object Object]" is pointless: no directive will be found in it
    // anyway, and an empty string honestly means "there was no trusted
    // text".
    return { kind: 'UserPromptSubmit', sessionId, prompt: typeof prompt === 'string' ? prompt : '' }
  }

  if (name === 'MessageDisplay') {
    const messageId = field(raw, 'message_id')
    const delta = field(raw, 'delta')
    // Without a message identifier the deltas cannot be tied together, and
    // tying them at random means attributing pieces of one message to
    // another.
    if (typeof messageId !== 'string' || messageId === '') {
      return { kind: 'unparsable', sessionId, reason: 'MessageDisplay without a message_id', silent: true }
    }
    // A delta that is not a string is not answer text. Coercing it to
    // "[object Object]" would mean checking a fabrication against
    // provenance.
    if (typeof delta !== 'string') {
      return { kind: 'unparsable', sessionId, reason: 'MessageDisplay: delta is not a string', silent: true }
    }
    // Finality is recognized only as a genuine true. The string "true" here
    // would close the message ahead of time: the footer would be attached to
    // a piece of the answer, and the remainder would reach the human without
    // it.
    return { kind: 'MessageDisplay', sessionId, messageId, final: field(raw, 'final') === true, delta }
  }

  if (name === 'PreToolUse' || name === 'PostToolUse') {
    const toolName = field(raw, 'tool_name')
    // A name that is not a string is left empty rather than coerced: the core
    // rejects an empty name by itself, while "[object Object]" would look like
    // a tool name.
    const tool = typeof toolName === 'string' ? toolName : ''
    const input = field(raw, 'tool_input')

    if (name === 'PreToolUse') {
      // Arguments that are not an object mean there is nothing to judge the
      // call by. Substituting an empty object here means letting a call
      // through with invisible arguments: both axes check exactly what they
      // were given.
      if (input !== undefined && !isRecord(input)) {
        return { kind: 'unparsable', sessionId, reason: `the tool_input of the call ${tool} did not arrive as an object` }
      }
      return { kind: 'PreToolUse', sessionId, call: { tool, args: isRecord(input) ? input : {} } }
    }

    // On PostToolUse the arguments take no part in the decision: the result
    // is what gets cleaned. Declining to clean because of the arguments' shape
    // would mean leaving the model uncleaned text for the sake of a field that
    // affects nothing here.
    return {
      kind: 'PostToolUse',
      sessionId,
      call: { tool, args: isRecord(input) ? input : {} },
      response: field(raw, 'tool_response'),
    }
  }

  return { kind: 'ignored', sessionId }
}

/**
 * Translates the core's decision into a form the harness understands.
 *
 * `allow` is printed as an empty object deliberately. An explicit
 * `permissionDecision: 'allow'` overrides the user's own permissions, that
 * is, Cordon would start handing out rights instead of bounding them.
 * Permission is silence.
 *
 * Quarantine is printed differently depending on the presence mode.
 *
 * In interactive mode `ask` is added to `updatedInput`: the harness shows the
 * user the modified input, and the human sees what exactly Cordon cut out.
 * Without that the argument edit happens silently, and a silently edited call
 * cannot be told apart from an unedited one — the harness documentation has
 * neither a substitution notice nor an indicator. It also removes a second
 * uncertainty: the applicability of `updatedInput` without
 * `permissionDecision` is not directly confirmed by the documentation, while
 * its combination with `ask` is described.
 *
 * In autonomous mode there is nobody to ask, and `allow` must not be printed:
 * it would override the user's own permissions. A lone `updatedInput` is
 * printed, and its applicability must be verified on a live harness by the
 * self-check command.
 *
 * `updatedInput` contains ALL the arguments, not only the changed ones: the
 * harness replaces the argument object whole, and a lost field means a call
 * with a missing argument. The core's quarantine returns a full copy, but
 * relying on that silently is not allowed, hence the test.
 */
export function renderDecision(decision: Decision, mode: PresenceMode): HookOutput {
  if (decision.kind === 'allow') return {}

  if (decision.kind === 'rewrite') {
    if (mode === 'autonomous') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: decision.args,
        },
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        // The names of the arguments that were cut are stated explicitly: the
        // human is confirming a modified call and must see what changed in it.
        permissionDecisionReason: `${decision.reason}; arguments changed: ${
          decision.removed.length > 0 ? decision.removed.join(', ') : 'none'
        }`,
        updatedInput: decision.args,
      },
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.kind,
      permissionDecisionReason: decision.reason,
    },
  }
}

/**
 * An event where a refusal is pointless and the hook's output decides nothing.
 *
 * In everything else Cordon is fail-closed: when in doubt, refuse. On
 * `MessageDisplay` it is the other way round. The event only draws an already
 * finished answer for the human, so a failure must end in an empty response:
 * the harness then shows the original text. A refusal here would protect
 * nothing and would cost the human the sight of the model's answer.
 * `PostToolUse` is on the same list for a different reason: the tool has
 * already run, there is nothing left to forbid.
 */
export function silentOnFailure(event: HookEvent): boolean {
  if (event.kind === 'PostToolUse' || event.kind === 'MessageDisplay') return true
  return event.kind === 'unparsable' && event.silent === true
}

/**
 * An event's field is read only as an own property.
 *
 * The event comes from outside, and a lookup through the prototype would
 * return a member of Object.prototype instead of an absent field:
 * "constructor" in the role of a tool name would pass as a genuine name.
 */
function field(source: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(source, name) ? source[name] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
