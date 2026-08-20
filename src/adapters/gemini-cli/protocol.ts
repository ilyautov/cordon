import type { Decision, PresenceMode, ToolCall } from '../../core/types.js'

export type HookEvent =
  | { kind: 'BeforeAgent'; sessionId: string; prompt: string }
  | { kind: 'BeforeTool'; sessionId: string; call: ToolCall; mcpServer?: string }
  | {
      kind: 'AfterTool'
      sessionId: string
      call: ToolCall
      /** The result's text. Empty when it could not be read as text. */
      content: string
      /**
       * There was content, and it did not read as text.
       *
       * Deliberately distinct from empty content: an empty result means
       * "there is nothing to read", while an unread one means "the model read
       * something and we did not". The second must end in a session mark,
       * otherwise the adapter's blindness looks like a clean result.
       */
      unreadable: boolean
      mcpServer?: string
    }
  | { kind: 'AfterAgent'; sessionId: string; response: string }
  | { kind: 'ignored'; sessionId: string }
  | { kind: 'unparsable'; sessionId: string; reason: string }

/**
 * The hook's response in Gemini CLI's shape.
 *
 * There is no field for substituting a tool result here, and that is not an
 * omission: the `AfterTool` event has none at all (§9.2). Neutralization on
 * this harness is expressed as a refusal, see `handlers.ts`.
 */
export interface HookOutput {
  decision?: 'deny' | 'ask'
  /** Goes to the model. On a refused tool result it carries the cleaned text. */
  reason?: string
  /** Shown to the human in the transcript and NOT returned to the model. */
  systemMessage?: string
  hookSpecificOutput?: {
    hookEventName: string
    /** Replaces the call's arguments whole. */
    tool_input?: Record<string, unknown>
    /**
     * Appended to the model's context. For neutralization it is useless and
     * harmful: the hidden layer stays in place and our note stands next to
     * it. Declared here so tests can check that we do not use it.
     */
    additionalContext?: string
  }
}

/**
 * Parses a harness event.
 *
 * Not a single field here is trusted: the JSON arrives on stdin, and tool
 * names are chosen by the MCP server. Parsing throws nothing — it returns
 * either an event or a refusal to parse, which the handler turns into a
 * decision. The reason is the same as on the first adapter, only sharper: on
 * this harness ANY hook failure means "allow", not a timeout alone (§9.2),
 * and a crashed hook is a pass.
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

  if (name === 'BeforeAgent') {
    const prompt = field(raw, 'prompt')
    // A prompt that is not a string is not a user message. Coercing an object
    // to "[object Object]" is pointless: no directive will be found in it
    // anyway, and an empty string honestly means "there was no trusted
    // text".
    return { kind: 'BeforeAgent', sessionId, prompt: typeof prompt === 'string' ? prompt : '' }
  }

  if (name === 'AfterAgent') {
    const response = field(raw, 'response')
    return { kind: 'AfterAgent', sessionId, response: typeof response === 'string' ? response : '' }
  }

  if (name === 'BeforeTool' || name === 'AfterTool') {
    const toolName = field(raw, 'tool_name')
    if (typeof toolName !== 'string' || toolName === '') {
      return { kind: 'unparsable', sessionId, reason: `${name} without a tool name` }
    }
    const input = field(raw, 'tool_input')

    if (name === 'BeforeTool') {
      // Arguments that are not an object mean there is nothing to judge the
      // call by. Substituting an empty object here means letting a call
      // through with invisible arguments: both axes check exactly what they
      // were given. An array instead of an object has already been caught on
      // the first adapter.
      if (input !== undefined && input !== null && !isRecord(input)) {
        return { kind: 'unparsable', sessionId, reason: `the tool_input of the call ${toolName} did not arrive as an object` }
      }
      return {
        kind: 'BeforeTool',
        sessionId,
        call: { tool: toolName, args: isRecord(input) ? input : {} },
        ...server(raw),
      }
    }

    // On AfterTool the arguments decide nothing: the tool has already run,
    // and the arguments are needed only to name the source. Declining to
    // observe because of their shape would mean losing a whole page's
    // provenance for the sake of a field that affects nothing here.
    const read = readContent(field(raw, 'tool_response'))
    return {
      kind: 'AfterTool',
      sessionId,
      call: { tool: toolName, args: isRecord(input) ? input : {} },
      content: read.text,
      unreadable: read.unreadable,
      ...server(raw),
    }
  }

  return { kind: 'ignored', sessionId }
}

/**
 * Translates the core's decision into a form the harness understands.
 *
 * `allow` is printed as an empty object. An explicit permission is never
 * issued here: Cordon bounds rights rather than handing them out, and a hook
 * decision that overrides the user's own confirmations would be handing them
 * out. Permission is silence.
 *
 * `ask` in autonomous mode turns into `deny` for two reasons at once. The
 * first is the same as on the first adapter: there is nobody to ask, and a
 * question nobody will see is not a defence. The second is specific: by §9.2
 * a forced `ask` in headless mode appears, judging by the harness's code, to
 * hang rather than fail, because the non-interactivity check runs before the
 * hook's decision is applied. A hung hook is worse than a failed one.
 *
 * Quarantine is printed as a lone `tool_input`, without `ask`. This diverges
 * from the first adapter, and deliberately: there `ask` was the only way to
 * show the human an argument edit, while here there is `systemMessage`, which
 * writes straight into the transcript and is not returned to the model. So
 * there is no reason to pay for visibility with a delayed call and an
 * undocumented combination of `ask` with argument substitution.
 *
 * `tool_input` contains ALL the arguments, not only the changed ones: the
 * harness replaces the argument object whole, and a lost field means a call
 * with a missing argument.
 */
export function renderDecision(decision: Decision, mode: PresenceMode): HookOutput {
  if (decision.kind === 'allow') return {}

  if (decision.kind === 'rewrite') {
    const removed = decision.removed.length > 0 ? decision.removed.join(', ') : 'none'
    return {
      // An argument edit the human does not see is indistinguishable from its
      // absence, and indistinguishability is what the whole project is built
      // against.
      systemMessage: `Cordon, argument quarantine: ${decision.reason}; arguments changed: ${removed}`,
      hookSpecificOutput: {
        hookEventName: 'BeforeTool',
        tool_input: decision.args,
      },
    }
  }

  const kind = decision.kind === 'ask' && mode === 'autonomous' ? 'deny' : decision.kind
  return { decision: kind, reason: decision.reason }
}

/**
 * The MCP server's name, when the call came from one.
 *
 * A fragment of an object is returned so that the absence of a name does not
 * turn into a field whose value is undefined: the event is compared whole in
 * tests.
 */
function server(raw: Record<string, unknown>): { mcpServer?: string } {
  const context = field(raw, 'mcp_context')
  if (!isRecord(context)) return {}
  const name = field(context, 'server_name')
  return typeof name === 'string' && name !== '' ? { mcpServer: name } : {}
}

interface Content {
  text: string
  unreadable: boolean
}

/**
 * A tool result's text.
 *
 * The content lies in `tool_response.llmContent` — that is what the model
 * reads. `returnDisplay` is deliberately not read: it is meant for the human
 * and may differ from what goes into the context, and what must be cleaned is
 * exactly what the model will see.
 *
 * `llmContent` has more than one shape: a string for most tools, a list of
 * parts for those returning several files or media. Only the text parts are
 * taken from a list. An image and other binary data are not text, and there
 * is no text to invent for them — but staying silent about them is not
 * allowed either, so unread content is marked separately.
 */
function readContent(response: unknown): Content {
  if (response === undefined || response === null) return { text: '', unreadable: false }
  const value = isRecord(response) ? field(response, 'llmContent') : response
  return readParts(value)
}

/**
 * The content's nesting limit.
 *
 * A list of parts is a list of parts, not a tree: real nesting here is one
 * level deep. The limit exists not for the format's sake but for the promise
 * that "parsing throws nothing": the whole content of `tool_response` is
 * chosen by the tool's server, and fifty thousand nested lists would overflow
 * the stack. The harness reads a thrown exception as "let it through", that
 * is, the result would reach the model unchecked — and that would be the
 * hole.
 */
const MAX_CONTENT_DEPTH = 8

function readParts(value: unknown, depth = 0): Content {
  if (typeof value === 'string') return { text: value, unreadable: false }
  if (value === undefined || value === null) return { text: '', unreadable: false }
  // We will not parse deeper, but pretending there was no content is not
  // allowed either: what went unread must stay named as unread.
  if (depth >= MAX_CONTENT_DEPTH) return { text: '', unreadable: true }

  if (Array.isArray(value)) {
    const pieces: string[] = []
    let unreadable = false
    for (const item of value) {
      const part = readParts(item, depth + 1)
      if (part.text !== '') pieces.push(part.text)
      if (part.unreadable) unreadable = true
    }
    // An empty list is the absence of content, not unread content.
    if (pieces.length === 0 && value.length === 0) return { text: '', unreadable: false }
    return { text: pieces.join(''), unreadable: unreadable || pieces.length === 0 }
  }

  if (isRecord(value)) {
    const text = field(value, 'text')
    if (typeof text === 'string') return { text, unreadable: false }
    return { text: '', unreadable: true }
  }

  // A number or a boolean in the role of content is not text, but neither is
  // it a page hidden from us: there is no reason to coerce them to a string.
  return { text: '', unreadable: false }
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
