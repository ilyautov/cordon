import { homedir } from 'node:os'
import { join } from 'node:path'
import { createMiddleware, ToolMessage } from 'langchain'
import { isHumanMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages'
import { Cordon } from '../../cordon.js'
import { PATH_KEYS, URL_KEYS, fold } from '../../core/argument-keys.js'
import type { Source, ToolCall } from '../../core/types.js'
import type { Policy } from '../../policy/defaults.js'
import { classifySource } from '../../provenance/trust.js'

export interface CordonMiddlewareOptions {
  policy: Policy
  /** Defaults to CORDON_HOME, then ~/.cordon — the same resolution the hooks use. */
  cordonHome?: string
  /**
   * The session identifier the state is kept under. The default follows the
   * core's own reasoning: one shared session is worse than separate ones but
   * safer than a random new one per run, where provenance is always empty.
   */
  sessionId?: string
}

/**
 * Cordon as a LangChain middleware: the same three-entry core contract as the
 * hook adapters, wired to the points `createAgent` exposes.
 *
 * The mapping, and why these hooks and no others:
 *
 * - `beforeModel` feeds the user's message. It runs before every model call,
 *   so a user turn is caught whenever it entered the history — including one
 *   another middleware injected mid-run. `beforeAgent` runs once per
 *   invocation and would miss that. The hook fires on every agent step, and
 *   the loop itself never appends human messages, so the same prompt would be
 *   fed as a new turn on every step — re-issuing the certificate and, worse,
 *   lifting the exposure mark a poisoned page just earned. The dedup below is
 *   what makes this hook safe to use.
 *
 * - `wrapToolCall` carries both remaining entries. Before the handler it is
 *   the gate: a refused call is answered with an error ToolMessage and the
 *   handler never runs, a rewrite calls the handler with the rewritten
 *   arguments. After the handler it is the observer: the result's text is
 *   cleaned and substituted when the source's view allows it.
 *
 * The adapter holds no security logic: every decision comes from `Cordon`,
 * so a LangChain agent and both hook harnesses answer the same call the same
 * way.
 */
export function createCordonMiddleware(options: CordonMiddlewareOptions) {
  const cordonHome = options.cordonHome ?? process.env['CORDON_HOME'] ?? join(homedir(), '.cordon')

  // The core's constructor throws on broken session state deliberately, and
  // the middleware is long-lived, so the throw lands at agent assembly time
  // rather than mid-run: a middleware that cannot keep provenance must never
  // look alive.
  const cordon = new Cordon({
    policy: options.policy,
    cordonHome,
    sessionId: options.sessionId ?? 'langchain',
  })
  const policy = options.policy

  /**
   * The last user turn already fed to the core, by position and text.
   *
   * Position and text, not object identity: LangGraph reconstructs message
   * objects between steps, so a reference comparison would see a "new"
   * message on every pass. The pair distinguishes the two ways a real new
   * turn arrives. With a checkpointer or full-history invocation the history
   * grows and the last human message moves to a new index; in stateless use,
   * where every invocation carries only the new message, the index stays and
   * the text changes. A blind spot remains and is named: the stateless
   * pattern with the identical text sent twice is indistinguishable from a
   * repeated pass, and skipping is the safe error there — feeding it again
   * would lift the exposure mark without anything having been seen.
   */
  let submitted: { index: number; text: string } | null = null

  return createMiddleware({
    name: 'CordonMiddleware',

    beforeModel: (state) => {
      const messages = state.messages
      let index = -1
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message !== undefined && isHumanMessage(message)) {
          index = i
          break
        }
      }
      if (index === -1) return undefined
      const text = messageText(messages[index]!)
      // A message without text carries nothing the core can use, and feeding
      // an empty string would still increment the turn.
      if (text === '') return undefined
      if (submitted !== null && submitted.index === index && submitted.text === text) return undefined
      submitted = { index, text }

      // An exception here — a broken session file — crashes the run loudly,
      // and that is the intent: both failure directions the hooks have (deny
      // on PreToolUse, silence on PostToolUse) are worse than a stopped agent
      // at the one moment the human's words are being taken in.
      cordon.onUserPrompt(text)
      return undefined
    },

    wrapToolCall: async (request, handler) => {
      const args = request.toolCall.args
      const call: ToolCall = {
        tool: request.toolCall.name,
        args: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
      }

      const decision = cordon.gate(call)

      // `ask` lands as a refusal here, exactly as in the MCP gateway: the
      // agent loop has no one to put the question in front of and resume, so
      // the interactive mode's question becomes a denial carrying the same
      // reason. The refusal is a ToolMessage in the protocol's own shape, so
      // the model reads the reason as the tool's output instead of inventing
      // a result.
      if (decision.kind === 'deny' || decision.kind === 'ask') {
        return new ToolMessage({
          content: `Cordon refused the call to ${call.tool || '(no tool named)'}: ${decision.reason}`,
          tool_call_id: request.toolCall.id ?? '',
          name: call.tool,
          status: 'error',
        })
      }

      // The handler is what executes the tool, and it invokes the tool with
      // the request's toolCall — so the rewrite is passed on by handing the
      // handler a request with the rewritten arguments. The original request
      // object is not mutated: it carries the arguments the model wrote, and
      // those are exactly what was cut.
      const effective = decision.kind === 'rewrite'
        ? { ...request, toolCall: { ...request.toolCall, args: decision.args } }
        : request
      const result = await handler(effective)

      return observeResult(result, call, cordon, policy)
    },
  })
}

/** The text of a message: the string content, or the text blocks joined. */
function messageText(message: BaseMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * The observation half of the contract: the tool's result is cleaned and
 * substituted when the source's view allows it, and provenance is recorded
 * either way — declining to substitute does not mean declining to remember.
 *
 * A result that is not a ToolMessage — a Command with a state update — or a
 * content block without text cannot be cleaned, and the model receives it.
 * Silence would read as a check that happened, so the session is marked and
 * the gate answers from there: the next call beyond reading escalates.
 */
function observeResult<R>(result: R, call: ToolCall, cordon: Cordon, policy: Policy): R {
  if (!ToolMessage.isInstance(result)) {
    cordon.markUnredacted()
    return result
  }

  const source = classifySource({ kind: 'tool', label: sourceLabel(call), tool: call.tool }, policy)
  const content = result.content

  if (typeof content === 'string') {
    const cleaned = observeText(content, call.tool, source, cordon)
    return (cleaned === content ? result : withContent(result, cleaned)) as R
  }

  if (!Array.isArray(content)) {
    cordon.markUnredacted()
    return result
  }

  let changed = false
  const blocks = content.map((block) => {
    if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
      const cleaned = observeText(block.text, call.tool, source, cordon)
      if (cleaned !== block.text) changed = true
      return { ...block, text: cleaned }
    }
    // An image, audio, a file reference: there is nothing the sanitizer can
    // clean, and the honest answer is the mark, not silence.
    cordon.markUnredacted()
    return block
  })
  return (changed ? withContent(result, blocks as MessageContent) : result) as R
}

/**
 * Observes one text and returns what the model should receive.
 *
 * When the source's view forbids substitution, the original stays and the
 * finding is said out loud through the journal — the channel the agent
 * cannot reach. There is no transcript footer on this transport: the
 * middleware never sees the model's rendered answer.
 */
function observeText(text: string, tool: string, source: Source, cordon: Cordon): string {
  const envelope = cordon.observe(text, source)
  if (envelope.substitute) return envelope.text
  if (envelope.findings.length > 0) {
    cordon.notice(tool, `a hidden layer was found in the result of ${tool}; it was not substituted`, source)
  }
  return text
}

/**
 * A ToolMessage rebuilt with the cleaned content.
 *
 * The artifact is preserved unchanged: it is the part of the output the model
 * is not shown, so nothing the model reads keeps the hidden layer. Dropping
 * it would take data from the application for no defensive gain.
 */
function withContent(message: ToolMessage, content: MessageContent): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: message.tool_call_id,
    name: message.name,
    ...(message.status === undefined ? {} : { status: message.status }),
    ...(message.artifact === undefined ? {} : { artifact: message.artifact }),
  })
}

/**
 * The source's name: a link or a path from the call's arguments, and the tool
 * name when there are none. The same rule as in both hook adapters — a tool
 * name instead of a link would kill trustedSources entirely, because the
 * declared prefix is then compared against the word "read_page".
 */
function sourceLabel(call: ToolCall): string {
  const args = Object.entries(call.args)
  for (const set of [URL_KEYS, PATH_KEYS]) {
    for (const [key, value] of args) {
      if (!set.has(fold(key))) continue
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return call.tool
}
