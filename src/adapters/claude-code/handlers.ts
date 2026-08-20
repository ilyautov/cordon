import { Cordon } from '../../cordon.js'
import { attribute } from '../../output/attribute.js'
import { renderFooter } from '../../output/footer.js'
import { SessionStore } from '../../session/store.js'
import { sweep } from '../../session/sweep.js'
import { humanReport, removingFindings } from '../../output/report.js'
import type { Policy } from '../../policy/defaults.js'
import { viewIsUnknown, type Source, type ToolCall } from '../../core/types.js'
import type { Finding } from '../../sanitize/types.js'
import { classifySource } from '../../provenance/trust.js'
import { extractText, replaceText } from './output.js'
import { renderDecision, silentOnFailure, type HookEvent, type HookOutput } from './protocol.js'

export interface AdapterEnv {
  policy: Policy
  cordonHome: string
}

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
export function handle(event: HookEvent, env: AdapterEnv): HookOutput {
  try {
    return dispatch(event, env)
  } catch (error) {
    // On PostToolUse there is nothing to substitute with: the core never came
    // up, the original goes to the model as-is, and the next call will run
    // into the same failure and get a deny. On MessageDisplay a refusal is not
    // what we want at all: see silentOnFailure.
    if (silentOnFailure(event)) return {}
    return deny(`Cordon failure: ${(error as Error).message}`)
  }
}

function dispatch(event: HookEvent, env: AdapterEnv): HookOutput {
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
  })

  if (event.kind === 'UserPromptSubmit') {
    cordon.onUserPrompt(event.prompt)
    // The sweep runs here and only here, and strictly AFTER the turn has been
    // written to disk. The order matters: walking a directory is the only
    // place where the hook may think for a long time, and a hook cut short by
    // a timeout would take the incremented turn number and the narrowing
    // requested by the directive down with it. The choice of event is in the
    // description of sweep.
    sweep(env.cordonHome, event.sessionId)
    return {}
  }

  if (event.kind === 'PostToolUse') return observe(cordon, event, env)

  // The presence mode comes from the policy: it decides whether quarantine is
  // shown to the human. There is no heuristic here and there cannot be one,
  // this is an explicit setting (§6).
  return renderDecision(cordon.gate(event.call), env.policy.mode)
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
    const { taint } = sessions.load(event.sessionId)
    const footer = renderFooter(attribute(text, taint))
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

function observe(
  cordon: Cordon,
  event: Extract<HookEvent, { kind: 'PostToolUse' }>,
  env: AdapterEnv,
): HookOutput {
  const extracted = extractText(event.call.tool, event.response)

  if (!extracted.known) {
    // We do not know the shape, so we cannot strip the layer, and the model
    // has already read it. Staying silent is not allowed: we mark the session,
    // and the gate decides from there.
    cordon.markUnredacted()
    return {}
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
    const envelope = cordon.observe(part, source)
    found.push(...envelope.findings)
    if (!envelope.substitute) substitute = false
    if (envelope.text !== part) changed = true
    return envelope.text
  })

  // A source the human sees as source text is never substituted, and the
  // check stands BEFORE `changed`: there is a finding in the file that was
  // read, and there will be no substitution. Provenance has already been
  // recorded by this point — that is a condition, not luck: refusing to hand
  // over the cleaned text does not undo the fact that the text was read.
  if (!substitute) return report(cordon, event.call.tool, source, found)

  if (!changed) return {}

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
function report(cordon: Cordon, tool: string, source: Source, findings: readonly Finding[]): HookOutput {
  const removing = removingFindings(findings)
  if (removing.length === 0) return {}

  // The reason named is the one that actually holds. About a file that was
  // read we know the human sees it as source text; about an MCP tool's result
  // we know nothing and substituted a default. Explaining the second with the
  // first means passing a guess off as knowledge in the very message that is
  // printed for the sake of honesty.
  const unknown = viewIsUnknown(source)
  const why = unknown
    ? `this source's view is not declared, and an MCP tool's result is treated as source by default. If ${tool} returns something rendered (a web page, a letter, a product card), declare it in the policy — toolsReturn: ${tool}: rendered — and the hidden layer will be cut out`
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

/**
 * The source kind from the tool name. The trust label is not set from here:
 * the core computes it in classifySource, and only it does.
 */
function sourceKind(tool: string): Source['kind'] {
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (tool === 'Bash') return 'bash'
  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'NotebookRead') return 'file'
  return 'tool'
}

/**
 * Links and paths in a call's arguments. The source is named by them.
 *
 * The names are folded to one form: `file_path` and `filePath` are chosen by
 * the MCP server, and they mean the same thing.
 */
const URL_KEYS: ReadonlySet<string> = new Set(['url', 'uri', 'href', 'link', 'endpoint'])
const PATH_KEYS: ReadonlySet<string> = new Set([
  'filepath', 'path', 'notebookpath', 'targetpath', 'dest', 'destination',
])

/**
 * The source's name: a link or a path from the call's arguments, and the tool
 * name when there are none.
 *
 * The tool name instead of a link looks like a harmless detail, but it kills
 * `trustedSources` entirely: the user declares a prefix like `/srv/docs`
 * trusted, and the word `Read` arrives for comparison, so the declaration
 * never matches. It also means the event log shows which document led to the
 * refusal instead of "Read".
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

function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
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
