import { Cordon } from '../../cordon.js'
import { viewIsUnknown, type EffectClass, type Source, type ToolCall } from '../../core/types.js'
import { attribute } from '../../output/attribute.js'
import { renderFooter } from '../../output/footer.js'
import { humanReport, removingFindings } from '../../output/report.js'
import type { Policy } from '../../policy/defaults.js'
import { classifySource } from '../../provenance/trust.js'
import { SessionStore } from '../../session/store.js'
import { sweep } from '../../session/sweep.js'
import { renderDecision, type HookEvent, type HookOutput } from './protocol.js'
import { PATH_KEYS, URL_KEYS, fold } from '../../core/argument-keys.js'

export interface AdapterEnv {
  policy: Policy
  cordonHome: string
}

/**
 * The length limit for the cleaned text inside a refusal's reason.
 *
 * The reason goes to the model as an error message, and a page of several
 * megabytes would turn a refusal into a harness crash. The truncation is
 * stated out loud: the model must know it is not seeing the whole text,
 * otherwise it will draw a conclusion from a stump and not notice.
 */
const MAX_REASON_TEXT = 20_000

/**
 * The harness event handler.
 *
 * The exception trap stands here rather than higher up, because the direction
 * of refusal depends on the event: on `BeforeTool` a failure is a `deny`, on
 * `AfterTool` and `AfterAgent` it is an empty response. An empty response on
 * `AfterTool` is not a hole: the next `BeforeTool` will meet the same failure
 * and end in a refusal, that is, the agent will not be able to act on the
 * unchecked text anyway.
 *
 * The trap's very presence is mandatory, and more so than on the first
 * adapter: there fail-open came from one event's timeout, here it comes from
 * ANY hook failure, and the configuration schema has no mandatory flag at all
 *.
 */
export function handle(event: HookEvent, env: AdapterEnv): HookOutput {
  try {
    return dispatch(event, env)
  } catch (error) {
    if (silentOnFailure(event)) return {}
    return { decision: 'deny', reason: `Cordon failure: ${(error as Error).message}` }
  }
}

/**
 * The events where a failure must end in silence rather than a refusal.
 *
 * The tool has already run, there is nothing to forbid; the end of a turn
 * decides nothing at all. A refusal here would protect nothing and would cost
 * the human the result of the work.
 */
export function silentOnFailure(event: HookEvent): boolean {
  return event.kind === 'AfterTool' || event.kind === 'AfterAgent'
}

function dispatch(event: HookEvent, env: AdapterEnv): HookOutput {
  if (event.kind === 'ignored') return {}
  if (event.kind === 'unparsable') {
    return { decision: 'deny', reason: `Cordon could not parse the harness event: ${event.reason}` }
  }

  // The end of a turn is handled BEFORE the core comes up. The core's
  // constructor throws on broken session state deliberately, and here an
  // exception would cost the human the footer and protect nothing: the event
  // decides nothing.
  if (event.kind === 'AfterAgent') return footer(event, env)

  const cordon = new Cordon({
    policy: withHarnessTools(env.policy, event),
    cordonHome: env.cordonHome,
    sessionId: event.sessionId,
  })

  if (event.kind === 'AfterTool') return observe(cordon, event, env)

  if (event.kind === 'BeforeTool') {
    // The presence mode comes from the policy: it decides whether to ask the
    // human. There is no heuristic here and there cannot be one, this is an
    // explicit setting.
    return renderDecision(cordon.gate(event.call), env.policy.mode)
  }

  const warnings = cordon.onUserPrompt(event.prompt)
  // The sweep runs here and only here, and strictly AFTER the turn has been
  // written to disk: walking a directory is the only place where the hook may
  // think for a long time, and a hook cut short by a timeout would take the
  // incremented turn number and the narrowing requested by the directive down
  // with it.
  sweep(env.cordonHome, event.sessionId)
  // A directive Cordon did not understand must be named out loud: silence
  // here would mean the human believes the rights are narrowed while they are
  // not. It goes to the human, not to the model.
  if (warnings.length === 0) return {}
  return { systemMessage: `Cordon: ${warnings.join('; ')}` }
}

/**
 * Gemini CLI's built-in tools and their effect classes.
 *
 * The table is its own, because the harnesses name their built-in tools
 * differently: `Read` on the first one and `read_file` on this one. A tool
 * absent from here is not classified by the core and its call is escalated —
 * that is, a mistake in a name costs an extra question rather than a pass.
 *
 * `run_shell_command` is a single `exec` class rather than a set of guesses
 * from the command's text: parsing the command means a shell parser, and any
 * shell parser can be worked around.
 */
const HARNESS_TOOLS: Readonly<Record<string, EffectClass[]>> = {
  read_file: ['read'],
  read_many_files: ['read'],
  list_directory: ['read'],
  glob: ['read'],
  search_file_content: ['read'],
  web_fetch: ['read', 'network-egress'],
  google_web_search: ['read', 'network-egress'],
  write_file: ['create', 'update'],
  replace: ['update'],
  run_shell_command: ['exec'],
  // A write into the agent's persistent memory outlives the session, that is,
  // it changes the behaviour of future turns. That is an edit, not a note.
  save_memory: ['create', 'update'],
}

/**
 * Adds the harness's built-in tool table to the policy.
 *
 * The user's declarations are laid on top and therefore win: the human's
 * policy is stronger than our idea of the harness.
 *
 * The table is NOT applied to a call from an MCP server. The tool name there
 * is chosen by the server, that is, by the untrusted side: a server that
 * named its tool `read_file` would get the built-in reader's rights for free.
 * Such a call must be classified by the policy, and an unclassified call is
 * escalated.
 */
function withHarnessTools(policy: Policy, event: HookEvent): Policy {
  const mcp = (event.kind === 'BeforeTool' || event.kind === 'AfterTool') && event.mcpServer !== undefined
  if (mcp) return policy
  return { ...policy, tools: { ...HARNESS_TOOLS, ...policy.tools } }
}

/**
 * The footer about source influence on a finished answer.
 *
 * It goes to the human through `systemMessage` and is NOT returned to the
 * model. That is not a presentation detail but the condition for the third
 * axis to exist at all: a footer that made it into the context would become
 * the carrier of the injection on the next turn — source labels come from the
 * untrusted world.
 *
 * An error here always ends in silence. This is the only place in Cordon
 * where fail-closed would be wrong: the event decides nothing, a refusal
 * would protect nothing, and it would cost the human the model's answer.
 *
 * The state is read directly, bypassing the core, and ONLY read. The state
 * file is the sole memory between hook processes, and every event is a
 * separate process: by writing it, the footer would overwrite everything a
 * neighbouring process managed to put into provenance between our read and
 * our write.
 *
 * There is no delta accumulation here and none is needed: `AfterAgent` hands
 * over the answer whole, so the draft machinery stays with the first adapter.
 */
function footer(event: Extract<HookEvent, { kind: 'AfterAgent' }>, env: AdapterEnv): HookOutput {
  try {
    if (!env.policy.output.footer) return {}
    const { taint } = new SessionStore(env.cordonHome).load(event.sessionId)
    const text = renderFooter(attribute(event.response, taint))
    if (text === '') return {}
    return { systemMessage: text }
  } catch {
    return {}
  }
}

/**
 * Observing a tool result and deciding whether to hand it to the model.
 *
 * The order is mandatory and it is the only possible one here: FIRST
 * `observe`, which records provenance, and only THEN the decision to refuse.
 * Refusing to hand the text to the model does not undo the fact that the text
 * was read: a source that did not make it into provenance will not be found
 * in call arguments later, and the data axis will stay silent where it was
 * obliged to answer. That is a quiet failure, and a quiet failure looks like
 * a working defence.
 *
 * Neutralization is expressed as a refusal, because there is nothing to
 * replace the result with on this harness. Appending through
 * `additionalContext` is never used: it would leave the hidden layer in place
 * and add our note beside it, that is, it would make things worse rather than
 * protect.
 *
 * The price is stated out loud: the clean part of the page reaches the model
 * wrapped in a refusal rather than as an ordinary result. That is the reverse
 * of the trade-off the project usually makes, and it is the price of this
 * harness.
 *
 * The refusal does not happen for every source. A file that was read and
 * shell output are seen by the human as source text, there is no layer hidden
 * from them there, and rejecting those would mean taking what was read away
 * from the agent for nothing: any HTML comment in a readable file would throw
 * out the whole result. The core makes the decision, see `humanSeesRendered`;
 * what remains here is the report.
 */
function observe(
  cordon: Cordon,
  event: Extract<HookEvent, { kind: 'AfterTool' }>,
  env: AdapterEnv,
): HookOutput {
  // The policy key is computed once: the declaration is looked up by it and
  // the tool is named by it in the hint to the human. Were those two names to
  // diverge, the hint would invite declaring something that will never become
  // a declaration.
  const key = policyKey(event.call.tool, event.mcpServer)
  const source = classifySource(
    {
      kind: sourceKind(event.call.tool, event.mcpServer),
      label: sourceLabel(event.call),
      tool: key,
    },
    env.policy,
  )

  // Provenance is recorded here, before any decision.
  const envelope = cordon.observe(event.content, source)

  if (event.unreadable) {
    // There was content and we did not read it as text. So the model read
    // what we did not see, and there was nothing to strip the layer with.
    // Staying silent is not allowed: we mark the session, and the gate decides
    // from there.
    cordon.markUnredacted()
  }

  const removing = removingFindings(envelope.findings)
  if (removing.length === 0) return {}

  const tool = event.call.tool

  if (!envelope.substitute) {
    // The reason named is the one that holds. About a file that was read we
    // know the human sees it as source text; about an MCP tool's result we
    // know nothing and substituted a default, and passing a default off as
    // knowledge in a message that exists for the sake of honesty is not
    // allowed.
    const unknown = viewIsUnknown(source)
    const why = unknown
      ? `this source's view is not declared, and an MCP tool's result is treated as source by default. If ${tool} returns something rendered (a web page, a letter, a product card), declare it in the policy — toolsReturn: ${key}: rendered`
      : 'the human sees this source as source text, and there is no reason to take it away from the agent'

    // There is no refusal: the result goes to the model whole, exactly as it
    // was. There is no session mark either — `markUnredacted` means "we could
    // not read the output's shape" and escalates the next call, and an honest
    // file with a comment must not be escalated. What remains is to say so out
    // loud, through both channels at once: the transcript for whoever is
    // sitting nearby, and the log for whoever reads it after an autonomous
    // run.
    cordon.notice(
      tool,
      `a layer hidden from the human was found in the result of ${tool}; the result was not rejected` +
        (unknown ? '; the source view is not declared, the source default is in force' : ''),
      source,
    )
    return {
      systemMessage: humanReport(
        {
          lead: `Cordon: the result of ${tool} contains a layer hidden from the human. The result was NOT rejected: ${why}.`,
          label: source.label,
          note: 'The hidden content (the model read it along with the rest of the text):',
        },
        removing,
      ),
    }
  }

  return {
    decision: 'deny',
    reason: modelReason(tool, envelope.text),
    systemMessage: humanReport(
      {
        lead: `Cordon: the result of ${tool} was rejected, it contained a layer hidden from the human.`,
        label: source.label,
        note: 'The hidden content (it was not passed to the model):',
      },
      removing,
    ),
  }
}

/**
 * The refusal reason that goes to the model. It carries the CLEANED text.
 *
 * The model gets what the human would have seen and not a line more: the
 * whole point of the exercise is that the hidden layer never reaches it.
 */
function modelReason(tool: string, clean: string): string {
  const cut = clean.length > MAX_REASON_TEXT
  const text = cut ? clean.slice(0, MAX_REASON_TEXT) : clean
  return [
    `Cordon: the result of ${tool} contained a layer hidden from the human and was not passed on whole.`,
    'Below is the cleaned text of the same result; acting on it is allowed, but the original result must not be considered read.',
    cut ? 'The text is truncated, only its beginning is shown.' : '',
    '',
    text,
  ].filter((line) => line !== '').join('\n')
}


/**
 * The source kind from the tool name. The trust label is not set from here:
 * the core computes it in classifySource, and only it does.
 *
 * Gemini CLI's built-in tool names differ from the first harness's, so the
 * table is its own. A call from an MCP server is handled separately and is
 * NOT matched against this table: the tool name there is chosen by the
 * server, that is, by the untrusted side, and a name coinciding with a
 * built-in one means nothing.
 */
/**
 * The key a tool is declared under in the policy (`toolsReturn`).
 *
 * The server's name travels in the key, and that matters. On this harness MCP
 * tool names differ from built-in ones in no way at all: a server may name
 * its tool `read_file`. A key made of the bare name would mean that a
 * declaration the human wrote about the built-in reader silently spread to a
 * foreign server that named itself the same — precisely the trust in a name
 * from an untrusted side, which is what the rule about tool names is against.
 */
function policyKey(tool: string, mcpServer?: string): string {
  return mcpServer === undefined ? tool : `${mcpServer}/${tool}`
}

function sourceKind(tool: string, mcpServer?: string): Source['kind'] {
  if (mcpServer !== undefined) return 'tool'
  if (tool === 'web_fetch' || tool === 'google_web_search') return 'web'
  if (tool === 'run_shell_command') return 'bash'
  if (FILE_TOOLS.has(tool)) return 'file'
  return 'tool'
}

const FILE_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content',
])

/**
 * Links and paths in a call's arguments. The source is named by them.
 *
 * The names are folded to one form: `file_path` and `filePath` are chosen by
 * the MCP server, and they mean the same thing.
 */

/**
 * The source's name: a link or a path from the call's arguments, and the tool
 * name when there are none.
 *
 * The tool name instead of a link looks like a harmless detail, but it kills
 * `trustedSources` entirely: the user declares a prefix trusted, and the word
 * `web_fetch` arrives for comparison, so the declaration never matches.
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

