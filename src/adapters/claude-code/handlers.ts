import { Cordon } from '../../cordon.js'
import { attribute } from '../../output/attribute.js'
import { renderFooter } from '../../output/footer.js'
import { outboundAfterRead, renderOutbound } from '../../output/egress.js'
import { SessionStore } from '../../session/store.js'
import { sweep } from '../../session/sweep.js'
import { holdSession } from '../../session/hold.js'
import { humanReport, removingFindings } from '../../output/report.js'
import type { Policy } from '../../policy/defaults.js'
import { viewIsUnknown, type Source, type ToolCall } from '../../core/types.js'
import type { Finding } from '../../sanitize/types.js'
import { classifySource } from '../../provenance/trust.js'
import { extractText, replaceText } from '../../output/tool-text.js'
import { renderDecision, silentOnFailure, type HookEvent, type HookOutput } from './protocol.js'
import { sourceLabel } from '../../core/argument-keys.js'
import { CLAUDE_CODE, type Dialect } from './dialect.js'

export interface AdapterEnv {
  policy: Policy
  cordonHome: string
}

/**
 * The length limit for the cleaned text inside a block's reason, as on the
 * Gemini CLI adapter: the reason is the whole of the hook's output, and a
 * page of several megabytes there was never measured on Codex or on the
 * DeepSeek bridge (Kimi, reviewing the connectors). A hook output the
 * harness cannot take is a hook that failed, and a failed hook lets the
 * original through. The cut is stated, so the model knows it holds a stump.
 */
const MAX_REASON_TEXT = 20_000

/**
 * The harness event handler.
 *
 * The exception trap stands here rather than higher up, because the direction
 * of refusal depends on the event: on `PreToolUse` a failure is a `deny`, on
 * `PostToolUse` it is the absence of a substitution. Higher up, where the
 * event can no longer be told apart, one direction would have to be chosen
 * for all. The trap's very presence is mandatory: the core's constructor
 * throws on broken session state deliberately, and the harness reads a
 * crashed hook as "let it through".
 */
export function handle(event: HookEvent, env: AdapterEnv, dialect: Dialect = CLAUDE_CODE): HookOutput {
  try {
    return dispatch(event, env, dialect)
  } catch (error) {
    if (event.kind === 'PostToolUse') return unscanned(event, env.cordonHome, dialect, error as Error)
    // On MessageDisplay a refusal is not what we want at all: see
    // silentOnFailure.
    if (silentOnFailure(event)) return {}
    return deny(`Cordon failure: ${(error as Error).message}`)
  }
}

function dispatch(event: HookEvent, given: AdapterEnv, dialect: Dialect): HookOutput {
  // A harness's own built-in tools lie under the policy's declarations, the
  // way Gemini's do: the owner's word on a tool wins.
  const env: AdapterEnv = Object.keys(dialect.builtin).length === 0
    ? given
    : { ...given, policy: { ...given.policy, tools: { ...dialect.builtin, ...given.policy.tools } } }
  if (event.kind === 'ignored') return {}
  if (event.kind === 'unparsable') {
    if (event.silent === true) return {}
    return deny(`Cordon could not parse the harness event: ${event.reason}`)
  }

  // The display event is handled BEFORE the core comes up. The core's
  // constructor throws on broken session state deliberately, and here an
  // exception would mean the model's answer hidden from the human.
  if (event.kind === 'MessageDisplay') return display(event, env)

  const cordon = new Cordon({
    policy: env.policy,
    cordonHome: env.cordonHome,
    sessionId: event.sessionId,
    rewrites: dialect.rewrites,
  })

  if (event.kind === 'UserPromptSubmit') {
    if (dialect.humanPrompts) cordon.onUserPrompt(event.prompt)
    // The sweep runs here and only here, and strictly AFTER the turn has been
    // written to disk. The order matters: walking a directory is the only
    // place where the hook may think for a long time, and a hook cut short by
    // a timeout would take the incremented turn number and the narrowing
    // requested by the directive down with it. The choice of event is in the
    // description of sweep.
    sweep(env.cordonHome, event.sessionId)
    return {}
  }

  if (event.kind === 'PostToolUse') return observe(cordon, event, env, dialect)

  // A harness that puts no question to anyone gets the unattended gate: the
  // question becomes a refusal naming a one-time approval. Printed as `ask`
  // there, it would run the call unasked — measured on Codex.
  const decision = dialect.asks ? cordon.gate(event.call) : cordon.gateUnattended(event.call)
  // The presence mode comes from the policy: it decides whether quarantine is
  // shown to the human. There is no heuristic here and there cannot be one,
  // this is an explicit setting.
  return renderDecision(decision, env.policy.mode)
}

/**
 * Appends a footer about source influence to the displayed answer.
 *
 * An error here always ends in an empty response: the harness then shows the
 * source text. This is the only place in Cordon where fail-closed would be
 * wrong. A refusal would protect nothing, because the event decides nothing,
 * and it would cost the human the sight of the model's answer.
 *
 * Nothing is returned into the model's context. `displayContent` changes only
 * what is shown on screen: a footer that made it into the context would
 * become the carrier of the injection on the next turn — that is precisely
 * why the third axis lives on this event rather than on substituting the
 * answer.
 *
 * The state is read directly, bypassing the core: display observes no sources
 * and issues no certificate, it needs only the provenance already
 * accumulated. And it is only read: the state file is the sole memory between
 * hook processes, and every event is a separate process. By writing it,
 * display would overwrite everything a neighbouring process managed to put
 * into provenance between our read and our write. That is why the accumulated
 * answer text lies in its own file and travels separately.
 */
function display(
  event: Extract<HookEvent, { kind: 'MessageDisplay' }>,
  env: AdapterEnv,
): HookOutput {
  try {
    // A switched-off footer means "this event does not exist for us": no
    // checking, and no accumulation of answer text on disk.
    if (!env.policy.output.footer) return {}

    const sessions = new SessionStore(env.cordonHome)
    const draft = sessions.loadDraft(event.sessionId)
    // The accumulated text is taken only from THIS message. A delta with a
    // different identifier means the previous one has ended: attributing its
    // text to a new answer means lying to the human about what they are
    // reading.
    const carried = draft?.messageId === event.messageId ? draft.text : ''
    const text = carried + event.delta

    if (!event.final) {
      // Provenance is not needed at all on an intermediate delta: the check
      // runs only on the final one. The state is not even read here.
      sessions.saveDraft(event.sessionId, { messageId: event.messageId, text })
      return {}
    }

    // The accumulated text is dropped before the check: the message has
    // ended, and there is no reason to keep its text on disk until the end of
    // the session.
    sessions.clearDraft(event.sessionId)

    // Provenance is read here and only here, and only read.
    const state = sessions.load(event.sessionId)
    const footer = renderFooter(attribute(text, state.taint)) + renderOutbound(outboundAfterRead(text, state, env.policy))
    // No footer means silence. An empty substitution would erase the delta.
    if (footer === '') return {}

    return {
      hookSpecificOutput: {
        hookEventName: 'MessageDisplay',
        // The delta is replaced whole, which is why it comes first: returning
        // the footer alone means erasing a piece of the model's answer from
        // the human.
        displayContent: event.delta + footer,
      },
    }
  } catch {
    return {}
  }
}

/**
 * A result the scan broke on. The tool has run, so there is nothing to
 * refuse, but the model reads a result nobody looked at. An empty answer
 * here assumed the next call would break the same way; a failure on the
 * result alone (a page with 140 000 comments, Codex) left the core sound and
 * the next call passed. So the session is held as for a result of unknown
 * shape, the human is told, and where the harness lets a result be replaced
 * by a block, the result is withheld.
 */
export function unscanned(
  event: Extract<HookEvent, { kind: 'PostToolUse' }>,
  cordonHome: string,
  dialect: Dialect,
  error: Error,
): HookOutput {
  const said = `Cordon failure: ${error.message}. The result of ${event.call.tool} was not scanned`
  const held = holdSession(cordonHome, event.sessionId)
  const after = held
    ? 'calls that act are held until your next message'
    : 'the hold on calls that act could not be recorded either, so it will not outlast this failure; stop the agent if the result matters'
  // The reason is the one channel a block is known to deliver: DeepSeek's
  // bridge drops systemMessage, and on Codex it was not measured (Codex).
  if (dialect.replaces === 'block') {
    return { decision: 'block', reason: `${said}, so it is withheld${held ? '' : `; ${after}`}.`, ...(held ? {} : { systemMessage: `${said}; ${after}.` }) }
  }
  return { systemMessage: `${said}; ${after}.` }
}

function observe(
  cordon: Cordon,
  event: Extract<HookEvent, { kind: 'PostToolUse' }>,
  env: AdapterEnv,
  dialect: Dialect,
): HookOutput {
  const extracted = extractText(event.call.tool, event.response, dialect.textless(event.call))

  if (!extracted.known || event.missing) {
    // We do not know the shape, so we cannot strip the layer, and the model
    // has already read it. Staying silent is not allowed: we mark the session,
    // and the gate decides from there.
    cordon.markUnredacted()
    // Not silence either (Kimi, reviewing the connectors): where a block can
    // withhold the result, it does; elsewhere the human is told.
    const why = event.missing ? 'the harness sent no result field' : 'its shape is unknown or too large'
    const said = `Cordon: the result of ${event.call.tool} could not be read (${why}), so a layer hidden in it could not be cut`
    if (dialect.replaces === 'block') return { decision: 'block', reason: `${said}; it is withheld.` }
    return { systemMessage: `${said}. Calls that act are held until your next message.` }
  }

  // The tool name is passed separately from the label: the source-view
  // declaration in the policy is looked up by it, while the label is a path or
  // a link from the arguments. On this harness an MCP tool's name already
  // carries the server's name (`mcp__server__tool`), so no key is assembled
  // for it.
  const source = classifySource(
    { kind: sourceKind(event.call.tool), label: sourceLabel(event.call), tool: event.call.tool },
    env.policy,
  )

  let changed = false
  let substitute = true
  const found: Finding[] = []
  const cleaned = extracted.parts.map((part) => {
    const envelope = cordon.observe(part.text, source, part.content ? 'content' : 'label')
    // Not spread: a page with 140 000 comments made a push with that many
    // arguments, which throws (Codex, reviewing the connectors).
    for (const finding of envelope.findings) found.push(finding)
    if (!envelope.substitute) substitute = false
    if (envelope.text !== part.text) changed = true
    return envelope.text
  })
  // Part of what the model read never reached the strings above. The core
  // decides what that means; the adapter only says it happened. An image is
  // answered as in the other adapters: content that could not be cleaned.
  // A bridge that flattens results is not known to have dropped anything, so
  // it only loses the inert exemption.
  cordon.observeLinks(extracted.links, source)
  if (extracted.opaque) cordon.observeUnseen(source)
  if (extracted.unseen) cordon.markUnredacted()
  else if (dialect.partialResults && !dialect.textless(event.call)) cordon.observeUnseen(source)
  // A lookup the policy declares binds names to values for the gate. The
  // core decides what that means; the adapter only hands over the text.
  cordon.recordLookup(event.call, cleaned.filter((_, index) => extracted.parts[index]!.content))

  // A source the human sees as source text is never substituted, and the
  // check stands BEFORE `changed`: there is a finding in the file that was
  // read, and there will be no substitution. Provenance has already been
  // recorded by this point — that is a condition, not luck: refusing to hand
  // over the cleaned text does not undo the fact that the text was read.
  if (!substitute) return report(cordon, event.call.tool, source, found, undefined, dialect.replaces !== 'none')

  if (!changed) return {}

  if (dialect.replaces === 'none') {
    // The harness hands the model the result whatever is printed, so the
    // model read the layer: the session is marked the way an unreadable
    // shape marks it, and the human and the journal are told.
    cordon.markUnredacted()
    return report(cordon, event.call.tool, source, found, dialect.name)
  }

  if (dialect.replaces === 'block') {
    // The harness shows the model a block's reason in place of the result.
    // The reason carries the cleaned pieces under Cordon's own heading.
    const text = cleaned.join('\n')
    const cut = text.length > MAX_REASON_TEXT
    return {
      decision: 'block',
      reason:
        `Cordon cut a layer hidden from the human out of the result of ${event.call.tool}; the cleaned result follows` +
        (cut ? ', truncated: only its beginning is shown.' : '.') + '\n\n' +
        (cut ? text.slice(0, MAX_REASON_TEXT) : text),
    }
  }

  const updated = replaceText(event.call.tool, event.response, cleaned)
  // replaceText refuses to substitute when the pieces did not match the
  // slots, and returns the original value. Printing it as a substitution is
  // pointless: the model would see the original while we would believe the
  // layer was stripped. That is exactly the quiet failure the shape is checked
  // twice for.
  if (updated === event.response) {
    cordon.markUnredacted()
    return {}
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: updated,
    },
  }
}

/**
 * A finding in a source we do not substitute: a file that was read, shell
 * output. No decision is made, a conversation with the human is.
 *
 * `markUnredacted` is NOT called here, and that is not forgetfulness. The mark
 * means "we could not read the output's shape" and escalates the next call.
 * A comment in an honest `index.html` must not be escalated: that is a false
 * positive during ordinary work, and by the project's rules that is worse
 * than a miss. We managed to read everything, there is simply nothing to fix
 * here.
 *
 * There are two channels, and they cover different states of affairs.
 * `systemMessage` is shown in the transcript and does not reach the model —
 * it is for the human sitting nearby. The log survives an autonomous run
 * where nobody reads the transcript, and it lies where the agent cannot
 * reach.
 */
function report(
  cordon: Cordon,
  tool: string,
  source: Source,
  findings: readonly Finding[],
  unreplaceable?: string,
  cuts = true,
): HookOutput {
  const removing = removingFindings(findings)
  if (removing.length === 0) return {}

  if (unreplaceable !== undefined) {
    const said = `a layer hidden from the human was found in the result of ${tool}, and ${unreplaceable} cannot replace a tool result: the model read it whole`
    cordon.notice(tool, said, source)
    return {
      systemMessage: humanReport(
        { lead: `Cordon: ${said}. Calls that act are held until your next message.`, label: source.label, note: 'The hidden content:' },
        removing,
      ),
    }
  }

  // The reason named is the one that actually holds. About a file that was
  // read we know the human sees it as source text; about an MCP tool's result
  // we know nothing and substituted a default. Explaining the second with the
  // first means passing a guess off as knowledge in the very message that is
  // printed for the sake of honesty.
  const unknown = viewIsUnknown(source)
  const why = unknown
    ? `this source's view is not declared, and an MCP tool's result is treated as source by default. If ${tool} returns something rendered (a web page, a letter, a product card), declare it in the policy — toolsReturn: ${tool}: rendered — and ${cuts
      ? 'the hidden layer will be cut out'
      // Kimi cannot replace a result, so the declaration buys a hold, not a cut (Codex).
      : 'calls that act will be held after such a layer; this harness cannot cut it out of a result'}`
    : 'the human sees this source as source text, and cutting from it would mean corrupting their file'

  cordon.notice(
    tool,
    `a layer hidden from the human was found in the result of ${tool}; the result was not substituted` +
      (unknown ? '; the source view is not declared, the source default is in force' : ''),
    source,
  )

  return {
    systemMessage: humanReport(
      {
        lead: `Cordon: the result of ${tool} contains a layer hidden from the human. The result was NOT substituted: ${why}.`,
        label: source.label,
        note: 'The hidden content (the model read it along with the rest of the text):',
      },
      removing,
    ),
  }
}

/** Built-in tools that fetch from the web, in every harness this adapter serves. */
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch', 'FetchURL', 'web_fetch', 'web_search', 'webrun'])

/** Built-in tools that read files. */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'ReadMediaFile', 'read', 'read_image', 'glob', 'grep', 'str_replace_editor',
])

/**
 * The source kind from the tool name. The trust label is not set from here:
 * the core computes it in classifySource, and only it does.
 */
function sourceKind(tool: string): Source['kind'] {
  if (WEB_TOOLS.has(tool)) return 'web'
  if (tool === 'Bash' || tool === 'bash') return 'bash'
  if (FILE_TOOLS.has(tool)) return 'file'
  return 'tool'
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
