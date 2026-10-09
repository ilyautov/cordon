import { createHash } from 'node:crypto'
import { humanSeesRendered, type Certificate, type ExposureMark, type Decision, type EffectClass, type Source, type ToolCall } from './core/types.js'
import { gate as decide } from './gate/gate.js'
import { memoryTarget } from './gate/memory.js'
import { comparePins, shadows, type HeldTool, type ListedTool } from './gate/pins.js'
import { pastedSecrets } from './gate/secrets.js'
import { FileNotifier, SILENT, labelled, stamped, type Notifier } from './notify/notifier.js'
import { policyHash } from './policy/hash.js'
import { loadPolicyFile } from './policy/load.js'
import { cutOutbound, outboundAfterRead } from './output/egress.js'
import type { Policy } from './policy/defaults.js'
import { readLookup, vouched, type Observation } from './provenance/bindings.js'
import { names, words } from './provenance/names.js'
import { atoms } from './provenance/normalize.js'
import { TaintStore } from './provenance/store.js'
import { sanitize } from './sanitize/index.js'
import type { Finding } from './sanitize/types.js'
import { issue, narrow, parseDirective, parseTrustMemory } from './scope/certificate.js'
import { MemoryLedger, type MemoryEntry } from './session/memory.js'
import { ApprovalStore, approvalId, canonical, type ApprovalContext } from './session/approvals.js'
import { PinStore } from './session/pins.js'
import { BudgetStore } from './session/budgets.js'
import { classify } from './scope/effects.js'
import { MAX_LOOKUPS, MAX_READ_IDS, MAX_USER_ATOMS, SessionStore, noteRead, type SessionState, type TurnNames } from './session/store.js'
import { assignments } from './provenance/assignments.js'

export interface Envelope {
  /** The cleaned text. It may be handed to the model only when `substitute`. */
  text: string
  source: Source
  findings: Finding[]
  /**
   * Whether the result may be replaced with the cleaned text.
   *
   * The core decides, not the adapter: the rule is one for all harnesses, and
   * forgetting it in one of the two adapters would mean destroying the user's
   * files on exactly one of them. See `humanSeesRendered`.
   */
  substitute: boolean
}

export interface CordonOptions {
  policy: Policy
  cordonHome: string
  notifier?: Notifier
  /**
   * The harness's session identifier. The default is deliberate: one shared
   * session is worse than separate ones but safer than a random new one per
   * call, where provenance is always empty.
   */
  sessionId?: string
  /**
   * The file the policy was loaded from, for an instance that outlives a
   * call (the MCP gateway). Each unattended decision compares it with the
   * policy in hand, and refuses once they differ: a stricter policy applied
   * while a gateway ran would otherwise leave the old rights in force,
   * approvals included (Codex).
   */
  policyFile?: string
  /**
   * Whether the harness applies changed arguments. Codex, Kimi and DeepSeek
   * Harness do not without an `allow` that would override the user's own
   * approvals, so there a rewrite is decided as a refusal here, before it
   * spends a budget or reaches the journal: decided in the adapter, the
   * journal said the fragment was cut and the call ran while the harness
   * was told to refuse it (Codex).
   */
  rewrites?: boolean
}

/**
 * What a piece of a tool's result is: something the source wrote, or something
 * it merely labelled. Only the first goes into provenance.
 */
export type PieceRole = 'content' | 'label'

/**
 * A tool reply that carries no words anyone wrote: empty, a bare literal, a
 * number, an empty collection. No instruction fits in one, so reading it does
 * not mark the session.
 */
const INERT = /^(?:|"?(?:none|null|undefined|true|false|ok|success)"?|\{\}|\[\]|-?\d+(?:\.\d+)?)$/iu

/** A link in one spelling: lower case, no trailing slash. */
function canonicalLink(link: string): string {
  return link.trim().toLowerCase().replace(/\/+$/u, '')
}

/**
 * Whether the user named this link. With a scheme the user wrote, the scheme
 * must match; a link the user wrote bare matches under either web scheme,
 * unless the user also wrote it with a scheme, which then decides. The user's
 * atoms carry the bare twin of every scheme link, hence the second check.
 */
function namedLink(link: string, named: ReadonlySet<string>): boolean {
  const canonical = canonicalLink(link)
  if (named.has(canonical)) return true
  const web = /^https?:\/\//u.exec(canonical)
  if (web === null) return false
  const bare = canonical.slice(web[0].length)
  return named.has(bare) && !named.has(`http://${bare}`) && !named.has(`https://${bare}`)
}

/**
 * The core's facade. Exactly three entries, matching the adapter contract of
 * three: trusted input, observing a tool result, deciding on a call.
 */
export class Cordon {
  private readonly policy: Policy
  private readonly cordonHome: string
  private readonly notifier: Notifier
  private readonly sessions: SessionStore
  private taint!: TaintStore
  private readonly ledger: MemoryLedger
  private cert!: Certificate
  private turn = 0
  private unredacted = false
  /** One id per untrusted result read in this session; see SessionState.readIds. */
  private readIds: string[] = []
  private directive: EffectClass[] | null = null
  private lastSource: Source | null = null
  /**
   * The session read untrusted content after the last user message. The mark
   * keys the gate's decision on the FACT of the read, not on a match against
   * what was read: the battery measured that the paraphrase/encoding tail of
   * attacks shares no recorded byte with its arguments, so provenance stays
   * silent there by construction.
   */
  private exposure: ExposureMark | null = null
  /**
   * Atoms from the user's own messages. A call under the exposure mark passes
   * when the user themselves named every one of its targets — the destination
   * came from the human, not from the page.
   */
  private userAtoms: string[] = []
  private userNames: string[] = []
  private userWords: string[] = []
  /** What declared lookups bound in this turn (`provenance/bindings.ts`). */
  private lookups: Observation[] = []
  /** The turn whose bindings are void: a record was lost or unreadable. */
  private lookupsVoidAt: number | null = null
  /** Names and atoms of the current turn's message: what a binding may key on. */
  private turnNames: TurnNames = { turn: 0, names: [] }
  /**
   * MCP tools held back in this process. Not persisted: the pins on disk are
   * the state, and every start of the gateway compares against them afresh.
   */
  private heldTools = new Map<string, { why: HeldTool['why']; server: string; imitates?: string }>()

  /** The state key on disk. It comes from the harness, that is, from outside. */
  readonly sessionId: string
  private readonly policyFile: string | null
  private readonly rewrites: boolean

  constructor(options: CordonOptions) {
    this.policy = options.policy
    this.policyFile = options.policyFile ?? null
    this.rewrites = options.rewrites ?? true
    this.cordonHome = options.cordonHome
    this.notifier = stamped(options.notifier ?? (options.policy.notify.file
      ? new FileNotifier(options.policy.notify.file)
      : SILENT), policyHash(options.policy))

    this.sessionId = options.sessionId ?? 'default'
    this.sessions = new SessionStore(this.cordonHome)
    // A broken state arrives here as an exception and leaves as one: catching
    // it here would mean starting the session with clean provenance, that is,
    // with the most permissive state, right after the file was corrupted.
    this.adopt(this.sessions.load(this.sessionId))

    // Read on construction, not lazily: a session with no user turns at all
    // (the MCP gateway) must start marked too, and a damaged ledger must
    // throw here, where the adapter turns it into a refusal.
    this.ledger = new MemoryLedger(this.cordonHome)
    this.carryMemory()
  }

  /** Takes a session state from disk as this instance's own. */
  private adopt(restored: SessionState): void {
    this.turn = restored.turn
    this.taint = restored.taint
    this.unredacted = restored.unredacted === true
    this.readIds = restored.readIds ?? []
    this.exposure = restored.exposure ?? null
    this.userAtoms = restored.userAtoms ?? []
    this.userNames = restored.userNames ?? []
    this.userWords = restored.userWords ?? []
    this.lookups = restored.lookups ?? []
    this.lookupsVoidAt = restored.lookupsVoidAt ?? null
    this.turnNames = restored.turnNames ?? { turn: 0, names: [] }

    // The certificate is NOT restored from disk: it is issued from the policy
    // on every run. Only the requested narrowing comes from disk, and it is
    // applied afresh.
    //
    // Every hook event is a separate process. Without this step the
    // directive `cordon: scope read` would not affect a single following
    // call: the certificate would be issued from the full profile, and the
    // scope would widen by itself between turns, which the narrowing rule does not
    // allow — only a new user message can widen the set.
    //
    // Storing the narrowing rather than the certificate matters: `narrow`
    // takes an intersection, so a substituted state file can only narrow.
    // Adding a class absent from the policy profile is impossible through it
    // by the function's construction, not by an agreement to store nothing.
    this.cert = issue(this.policy, this.turn)
    this.directive = restored.directive ?? null
    if (this.directive) this.cert = narrow(this.cert, this.directive)
  }

  /**
   * Re-reads the session from disk before an unattended decision.
   *
   * A LangChain agent can hold one instance for a whole run while another
   * worker shares its session: what the other read, or the scope the user
   * narrowed there, is on disk and not in this instance's memory, and an
   * approval checked against memory alone passed after it (Codex). The hook
   * adapters start a process per event and are fresh already.
   */
  /**
   * Why the policy in hand is no longer the one on disk, or null. Not
   * reloaded in place: the certificate, the pins and the questions already
   * asked were all made under the old one, and a restart is the one
   * boundary where all of them start over together.
   */
  private policyMoved(): string | null {
    if (this.policyFile === null) return null
    let current: string
    try {
      current = policyHash(loadPolicyFile(this.policyFile))
    } catch (error) {
      // Unreadable is not "unchanged": the call is refused, loudly.
      return `the policy at ${this.policyFile} can no longer be read (${(error as Error).message}); nothing is done until it is fixed and Cordon restarted`
    }
    if (current === policyHash(this.policy)) return null
    return `the policy at ${this.policyFile} changed after this Cordon started; restart it to act under the policy now in force`
  }

  private refresh(): void {
    this.adopt(this.sessions.load(this.sessionId))
    this.carryMemory()
  }

  /** Trusted input. The only place where the certificate can change. */
  onUserPrompt(text: string): string[] {
    this.turn += 1
    this.cert = issue(this.policy, this.turn)
    // The previous narrowing is lifted before the new directive is parsed.
    // This is the narrowing rule in full: only the user widens the set of rights, and
    // the message they have just written is that widening.
    this.directive = null
    const warnings: string[] = []

    // A new user message lifts the mark: the user has seen the model's answer
    // written from uncleaned text and can stop it. Holding the escalation
    // longer means punishing them for what they have already checked with
    // their own eyes.
    this.unredacted = false

    // The exposure mark is lifted on the same argument: whatever the model
    // did with the untrusted content it read, the user has seen the outcome
    // of that turn and could intervene. What the user names in the message is
    // remembered instead: a call made under the mark passes when every one of
    // its targets was named here, by the human rather than by the page. The
    // extraction is the same `atoms` provenance uses, so a link or an
    // identifier means the same token on both sides of the comparison.
    this.exposure = null
    // Memory written under exposure is the exception to the argument above:
    // the user saw the turn in which it was written, but the harness reloads
    // the file into every turn after, and nothing the user saw vouches for
    // what it now says. Only the user's explicit word lifts it — parsed from
    // this message and nowhere else, so the note cannot vouch for itself.
    if (parseTrustMemory(text)) this.ledger.clear()
    else this.carryMemory()
    this.rememberNamed(text)

    const requested = parseDirective(text)
    if (requested && requested.length > 0) {
      this.directive = requested
      this.cert = narrow(this.cert, requested)
    } else if (requested) {
      // There was a directive, but not a single known class was found in it.
      // Narrowing to the empty set means immobilizing the agent until the end
      // of the turn over a typo in one word. We keep the certificate and say
      // so out loud.
      warnings.push('the cordon: scope directive contains no known effect classes, the certificate is unchanged')
    }

    this.persist()
    return warnings
  }

  /**
   * A tool call's result. Cleaned, then recorded into provenance.
   *
   * Provenance is recorded ALWAYS and does not depend on whether the cleaned
   * text or the original reaches the model. Declining to substitute does not
   * mean declining to remember: a source that did not make it into provenance
   * will not be found in call arguments later, and the data axis will stay
   * silent where it must answer.
   *
   * When there will be no substitution, the original text goes into
   * provenance too. The model will read exactly that, so it may assemble an
   * argument out of a piece that is not in the cleaned text at all. Recording
   * too much here is cheaper than not recording: what is not recorded is
   * never found.
   */
  /**
   * Cleans a piece of a tool's result and remembers where it came from.
   *
   * `role` separates two questions that are not the same one. Every text
   * piece handed here is cleaned and counts as a read. Only content enters
   * provenance: a heading, a name or the query echoed back can
   * be the user's own value, and recording it would taint an honest retry.
   * A label can still contain an instruction, so it cannot exempt a later
   * action from the exposure rule merely because its field name is structural.
   */
  observe(text: string, source: Source, role: PieceRole = 'content'): Envelope {
    const { clean, findings } = sanitize(text)
    const substitute = humanSeesRendered(source)
    if (role === 'content') {
      this.taint.record(clean, source)
      if (!substitute && clean !== text) this.taint.record(text, source)
    }
    // The fact of the read is marked apart from provenance: a title-only
    // result can steer a new recipient without sharing words with the call.
    // An empty or status-only reply is the exception; both the original and
    // cleaned text must be inert, so a hidden layer around "ok" still marks.
    const inert = INERT.test(clean.trim()) && INERT.test(text.trim())
    if (source.trust === 'untrusted' && !inert) this.exposure = { at: this.turn, source: source.label }
    // A tool description is read once for the whole session, in a batch, so
    // "the last one" is an arbitrary name; the live MCP run showed it being
    // blamed for a certificate refusal it had no part in. Descriptions still
    // mark the session and enter provenance above — they are only kept out of
    // the journal's guess.
    if (source.trust === 'untrusted' && source.kind !== 'mcp-description') this.lastSource = source
    if (source.trust === 'untrusted') this.readIds = noteRead(this.readIds)
    this.persist()
    return { text: clean, source, findings, substitute }
  }

  /**
   * An MCP server's tool list, against the tools its owner approved. Returns
   * the tools to hold back from the model; calls to them are refused.
   *
   * The first listing of a server is pinned as it is. A damaged pin file
   * throws: read as empty, it would approve whatever the server lists now.
   */
  admitTools(command: readonly string[], listed: readonly ListedTool[]): HeldTool[] {
    if (this.policy.mcp?.pin === false) return []
    const store = new PinStore(this.cordonHome)
    const result = comparePins(store.load(command), listed)
    if (result.firstSight) store.save(command, result.pins)

    // A shadow is held whatever the pins say, on every start: approving the
    // server does not make its name a different name. It is checked against
    // the other servers' pins, which is the only place one gateway can see
    // the others from.
    const imitations = shadows(listed, store.others(command))
    const shadowed = new Set(imitations.map((shadow) => shadow.name))
    const held: HeldTool[] = [
      ...imitations.map((shadow) => ({ name: shadow.name, why: 'shadow' as const, imitates: shadow.imitates })),
      ...result.held.filter((tool) => !shadowed.has(tool.name)),
    ]

    const server = command.join(' ')
    this.heldTools = new Map(held.map((tool) => [tool.name, { why: tool.why, server, ...(tool.imitates === undefined ? {} : { imitates: tool.imitates }) }]))
    for (const tool of held) {
      const other = imitations.find((shadow) => shadow.name === tool.name)
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: 'mcp-drift',
        tool: tool.name,
        reason: other !== undefined
          ? `the tool on ${server} imitates ${other.imitates} of ${other.server} with lookalike characters; ` +
            'it is hidden from the model and refused, and approving the server does not release it'
          : `the tool ${tool.why === 'new' ? 'appeared' : 'changed'} after ${server} was approved; ` +
            'it is hidden from the model and refused until "cordon mcp approve"',
        source: null,
        ...labelled('pin'),
      })
    }
    return held
  }

  /** The owner's approval: the server's next start pins its tools afresh. */
  static approveServer(cordonHome: string, command: readonly string[]): boolean {
    return new PinStore(cordonHome).forget(command)
  }

  gate(call: ToolCall): Decision {
    return this.judge(call, true)
  }

  /**
   * The decision, spent against the budgets. A question spends when a human
   * in the harness answers it; asked of nobody, it spends only when an
   * approval is taken (gateUnattended), or every retry would count twice.
   */
  private judge(call: ToolCall, askSpends: boolean): Decision {
    let decision = decide(call, {
      policy: this.policy,
      cert: this.cert,
      taint: this.taint,
      cordonHome: this.cordonHome,
      turn: this.turn,
      unredacted: this.unredacted,
      exposure: this.exposure,
      userAtoms: this.userAtoms,
      userNames: this.userNames,
      userWords: this.userWords,
      vouched: this.vouched(),
      assigned: new Set(this.turnNames.turn === this.turn ? this.turnNames.assigned ?? [] : []),
      heldTools: this.heldTools,
    })

    // A rewrite is journaled alongside the refusals, and it is the entry the
    // journal can least afford to be missing. A refusal leaves a mark on its
    // own: the call did not happen, the model says so, the human sees it. A
    // rewrite is the one outcome where the call goes through and the result
    // is not what the model asked for — the file gets written with a piece
    // cut out of it, and the model reports having written the whole thing,
    // because it never learns otherwise. Measured on Claude Code 2.1.236: the
    // harness applies the substituted arguments and the model's own account
    // of the turn is wrong about what landed on disk. Without this line the
    // only record of that is the file itself.
    if (decision.kind === 'rewrite' && !this.rewrites) {
      // The cut cannot be applied, and running the call uncut is the attack.
      decision = {
        kind: 'deny',
        rule: decision.rule,
        reason: `${decision.reason}; this harness cannot run a call with its arguments changed, so the call is refused ` +
          `(arguments that carried it: ${decision.removed.length > 0 ? decision.removed.join(', ') : 'none'})`,
        ...(decision.source === undefined ? {} : { source: decision.source }),
      }
    }
    if (askSpends || decision.kind !== 'ask') decision = this.spend(call, decision)
    this.recordMemory(call, decision)
    // A call is let through only by a core that can still write. The mark a
    // result left (unscanned, exposure) lives on disk, and a store that
    // stopped taking writes lost it without a word: the next core read the
    // older state and allowed (Codex, reviewing the connectors). Writing
    // here throws on such a store, and the adapter turns that into a refusal.
    if (decision.kind === 'allow' || decision.kind === 'rewrite') this.persist()

    if (decision.kind === 'deny' || decision.kind === 'ask' || decision.kind === 'rewrite') {
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: decision.kind,
        tool: call.tool,
        reason: decision.reason,
        // What the gate knows beats what the core guesses: the source the
        // decision turned on, and only failing that, the last page read.
        source: decision.source ?? this.lastSource?.label ?? null,
        ...labelled(decision.rule),
      })
    }

    return decision
  }

  /**
   * The gate, for a transport with nobody to put a question to: the MCP
   * gateway and the LangChain middleware.
   *
   * There the interactive mode's question used to become a plain refusal, and
   * an agent refused has nowhere to go. Now the refusal names a one-time
   * approval for this exact call. The owner runs `cordon approve <id>`, and
   * the same call, retried, goes through once. The id is bound to the
   * session, the tool and every argument, so an approval cannot be spent on
   * a different recipient, and it expires within the hour.
   *
   * Only a question is offered. A refusal the gate means as a refusal
   * (self-protection, a held tool, anything in autonomous mode) stays one:
   * there the policy is what should change, in the open.
   */
  gateUnattended(call: ToolCall): Decision {
    const moved = this.policyMoved()
    if (moved !== null) {
      this.notifier.notify({ at: new Date().toISOString(), decision: 'deny', tool: call.tool, reason: moved, source: null, ...labelled('failure') })
      return { kind: 'deny', rule: 'failure', reason: moved }
    }
    this.refresh()
    const decision = this.judge(call, false)
    if (decision.kind !== 'ask') return decision

    const approvals = new ApprovalStore(this.cordonHome)
    // The question is bound to everything it was asked under: this call,
    // under this rule, with this much untrusted content read, in this user
    // turn, under this certificate and this policy (FIDES binds a grant to
    // its context the same way). Asked before a page and retried after it,
    // the same arguments may be the page's idea. The id is the binding's own
    // prefix, so the owner approves exactly the question they were shown:
    // a changed context is a new question under a new id, never the old id
    // quietly pointing at a new question.
    const context: ApprovalContext = {
      rule: decision.rule,
      exposure: this.exposure?.source ?? null,
      policy: policyHash(this.policy),
      turn: this.turn,
      reads: this.readIds.length,
    }
    const binding = digest(canonical([
      this.sessionId, call.tool, call.args ?? {}, context, this.exposure, this.unredacted, this.cert,
      this.readIds, digest(canonical(this.taint.toJSON())),
    ]))
    const id = binding.slice(0, 16)
    const callKey = approvalId(this.sessionId, call)
    for (const earlier of approvals.retireOthers(callKey, id)) {
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: 'approval-void',
        tool: call.tool,
        reason: `the question ${earlier.id} about this call was asked ${changed(earlier.context, context)}; ` +
          `it is void, with any approval given to it, and the call now waits under ${id}`,
        source: decision.source ?? null,
        ...labelled(decision.rule),
      })
    }
    // The budget is counted before the approval is taken: over the limit,
    // the call is refused, no approval is spent and no question is asked,
    // since no answer could lift it; a take that finds nothing gives the
    // reservation back.
    const held = this.reserve(call)
    if (held.refusal !== null) {
      const refusal = held.refusal
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: 'deny',
        tool: call.tool,
        reason: refusal.kind === 'deny' ? refusal.reason : '',
        source: null,
        ...labelled(refusal.kind === 'deny' ? refusal.rule : 'failure'),
      })
      return refusal
    }
    // Written before the approval is spent, as before any allow (judge): a
    // store that takes no write throws here, and the approval stays unspent
    // for a core that can remember what it let through (Codex).
    this.persist()
    const taken = approvals.take(id, binding)
    if (!taken.taken) {
      try {
        held.release()
      } catch {
        // A reservation left in place over-counts; the call is refused either way (Kimi).
      }
    }
    if (taken.void) {
      // Same id, another binding: a prefix collision or a planted file. Never
      // taken, and never quietly (Kimi).
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: 'approval-void',
        tool: call.tool,
        reason: `an approval under ${id} carried another binding than this question; it is void`,
        source: decision.source ?? null,
        ...labelled(decision.rule),
      })
    }
    if (taken.taken) {
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: 'approved',
        tool: call.tool,
        reason: `the owner approved this call once (${id}): ${decision.reason}`,
        source: decision.source ?? null,
        ...labelled(decision.rule),
      })
      return { kind: 'allow' }
    }

    // A failure to record the request is not allowed to become an allow or
    // silence: it propagates, and the transport refuses the call on its own
    // failure path.
    approvals.request(id, { tool: call.tool, reason: decision.reason, args: call.args, binding, context, call: callKey })
    this.notifier.notify({
      at: new Date().toISOString(),
      decision: 'approval-requested',
      tool: call.tool,
      reason: `waiting for "cordon approve ${id}": ${decision.reason}`,
      source: decision.source ?? null,
      ...labelled(decision.rule),
    })
    return {
      kind: 'deny',
      rule: decision.rule,
      approvalId: id,
      reason: `${decision.reason}. Nobody is here to ask, so the call is refused; the owner can allow this exact call once ` +
        `with "cordon approve ${id}", and retrying it unchanged then goes through`,
      ...(decision.source === undefined ? {} : { source: decision.source }),
    }
  }

  /** A host no longer waits for this exact question; a late yes must not release another call. */
  cancelUnattendedApproval(id: string, reason: string): void {
    const request = new ApprovalStore(this.cordonHome).cancel(id)
    if (request === null) return
    this.notifier.notify({
      at: new Date().toISOString(),
      decision: 'approval-void',
      tool: request.tool,
      reason: `the question ${id} was cancelled: ${reason}`,
      source: null,
      id,
    })
  }

  /**
   * Feeds the task text from the policy as a source of user atoms.
   *
   * It exists for transports with no user turns at all — the MCP gateway:
   * the certificate there is the profile for the whole run, and nothing the
   * human says ever arrives. The task text is trusted configuration, so atoms
   * from it stand for the human's own naming, and the exposure exemption
   * compares a call's targets against them exactly as it compares against
   * user messages.
   *
   * onUserPrompt is deliberately NOT reused, on two counts. It increments the
   * turn and reissues the certificate, and no turn has happened — nothing was
   * said. And it lifts the exposure mark, on the argument that the user has
   * seen the turn's outcome and could intervene; here nobody has seen
   * anything, and on this transport nobody will — the mark stands until the
   * process ends. What is shared is the atom extraction itself, so a link or
   * an identifier means the same token on both sides of the comparison.
   */
  declareTask(text: string): void {
    this.rememberNamed(text)
    this.persist()
  }

  /**
   * Links a result carried in identifier fields, which the adapter does not
   * clean. A link the user named is theirs coming back and changes nothing;
   * any other from an untrusted source is the source's, so it goes into
   * provenance and marks the read, whatever the rest of the result said
   * (Codex, reviewing the connectors: `ok` with `url: <attacker's page>`).
   */
  observeLinks(links: readonly string[], source: Source): void {
    if (source.trust !== 'untrusted') return
    // Compared whole, as the gate compares a named destination: the user
    // writes www.shop.example/item and the tool returns
    // https://www.shop.example/item/, and matching atom by atom failed there,
    // since a scheme link yields twins the bare one does not. A scheme the
    // user wrote must match, so an http downgrade of their https link is not
    // theirs; words do not vouch, since a version or a file name the user
    // typed passed an attacker's https://20.11.0 (Kimi, reviewing this
    // change). A bare host is no atom, so it is not named here either, as it
    // is not for the gate.
    const named = new Set(this.userAtoms.map(canonicalLink))
    let foreign = false
    for (const link of links) {
      if (namedLink(link, named)) continue
      // A link with no atoms cannot enter provenance, but it is still the
      // source's: it marks the read rather than passing for the user's.
      this.taint.record(link, source)
      foreign = true
    }
    if (!foreign) return
    this.exposure = { at: this.turn, source: source.label }
    if (source.kind !== 'mcp-description') this.lastSource = source
    this.readIds = noteRead(this.readIds)
    this.persist()
  }

  /**
   * Marks the fact of a read whose content Cordon did not clean: an image,
   * a source-selected opaque identifier, or a harness that hands the hook
   * only part of what the model got. These values must keep their spelling,
   * but an inert `text: "ok"` beside them cannot exempt the later action.
   */
  observeUnseen(source: Source): void {
    if (source.trust !== 'untrusted') return
    this.exposure = { at: this.turn, source: source.label }
    if (source.kind !== 'mcp-description') this.lastSource = source
    this.readIds = noteRead(this.readIds)
    this.persist()
  }

  /**
   * Marks that the hidden layer could not be stripped from a tool result.
   *
   * Called by the adapter when the output's shape is unfamiliar: substituting
   * it is not allowed, because the harness would discard a substitution of the
   * wrong shape and show the model the original. Staying silent is not allowed
   * either — the model has already read it. Hence the mark: the next call
   * beyond reading is escalated.
   */
  markUnredacted(): void {
    this.unredacted = true
    this.readIds = noteRead(this.readIds)
    this.persist()
  }

  /**
   * Tells the human about a finding that no decision is made on.
   *
   * It exists for one case: a hidden layer was found in a file that was read,
   * the result must not be substituted, and escalating is even less
   * acceptable — honest HTML with a comment is not an attack. What remains is
   * to say so out loud. Silence here would be the state "Cordon saw it and
   * said nothing", and that is worse than both a miss and a false positive:
   * the human believes a check took place, and the check checked nothing.
   *
   * The channel is the same as for gate decisions, deliberately: the log is
   * the place the agent cannot reach, and the thing that survives an
   * autonomous run where nobody reads the transcript. The `notice` mark
   * separates such a record from `deny` and `ask`: nothing is forbidden by it.
   *
   * The session state is not touched at all. A notification is not an
   * escalation, and the next call is not changed by it one bit.
   */
  notice(tool: string, reason: string, source: Source): void {
    this.notifier.notify({
      at: new Date().toISOString(),
      decision: 'notice',
      tool,
      reason,
      source: source.label,
    })
  }

  /**
   * The model's answer, with the images and data-carrying links cut that
   * would send something out when it is shown, after an untrusted read. For
   * a transport that holds the answer before anyone sees it; the hooks only
   * see it on its way to the screen and warn instead.
   *
   * The cut is journalled: the owner learns that a page tried the channel,
   * which the transcript alone would hide behind the note.
   */
  answer(text: string): string {
    const found = outboundAfterRead(text, {
      taint: this.taint,
      exposure: this.exposure,
      unredacted: this.unredacted,
      userAtoms: this.userAtoms,
    }, this.policy)
    if (found.length === 0) return text
    const hosts = [...new Set(found.map((item) => `${item.host} (${item.kind})`))].join(', ')
    this.notifier.notify({
      at: new Date().toISOString(),
      decision: 'notice',
      tool: '(answer)',
      reason: `cut from the answer after an untrusted read, as addresses that would carry data out: ${hosts}`,
      source: this.exposure?.source ?? null,
    })
    return cutOutbound(text, found)
  }

  /**
   * Counts a call against the policy's budgets, or refuses it. A call that
   * may run spends: allowed, rewritten, or put to a human in the harness,
   * who may say yes (Codex, Kimi: a call behind an approval ran uncounted).
   * The reservations of one call are all or nothing: refused by one budget,
   * it takes back what it reserved in the others.
   *
   * A refused call does not spend: counting it would let a page that
   * provokes refusals spend the owner's budget. Over the limit is a refusal
   * in either mode and never a question, since a budget is the owner's
   * answer given in advance. A store that cannot be counted refuses. Only a
   * classified effect is counted: an unclassified tool matches no budget.
   */
  private spend(call: ToolCall, decision: Decision): Decision {
    if (decision.kind !== 'allow' && decision.kind !== 'rewrite' && decision.kind !== 'ask') return decision
    const held = this.reserve(call)
    return held.refusal ?? decision
  }

  private reserve(call: ToolCall): { refusal: Decision | null; release: () => void } {
    const budgets = this.policy.budgets ?? []
    const none = { refusal: null, release: () => {} }
    if (budgets.length === 0) return none
    const verdict = classify(call, this.policy.tools)
    const effects = verdict.classified ? verdict.effects : []
    const store = new BudgetStore(this.cordonHome)
    const held: Array<() => void> = []
    const release = (): void => {
      for (const undo of held) undo()
    }
    for (const budget of budgets) {
      if (!effects.includes(budget.effect)) continue
      let reservation
      try {
        reservation = store.reserve(budget)
      } catch (error) {
        // Taking back what was reserved can fail the same way; the call is
        // refused either way, and a count left too high refuses, never lets by.
        try {
          release()
        } catch {
          // Over-counted, not under-counted.
        }
        return {
          refusal: {
            kind: 'deny',
            rule: 'failure',
            reason: `Cordon failure: the budget for ${budget.effect} could not be counted (${(error as Error).message}); the call is refused rather than let through uncounted`,
          },
          release: () => {},
        }
      }
      if (!reservation.ok) {
        try {
          release()
        } catch {
          // Over-counted, not under-counted: the refusal stands.
        }
        return {
          refusal: {
            kind: 'deny',
            rule: 'budget',
            reason: `the budget for ${budget.effect} is spent: ${reservation.used} of ${budget.limit} per ${budget.per}; ` +
              'the call is refused until the window moves on, whatever else allowed it',
          },
          release: () => {},
        }
      }
      held.push(reservation.release)
    }
    return { refusal: null, release }
  }

  /** The effective policy this instance decides under. */
  policyInForce(): Policy {
    return this.policy
  }

  certificate(): Certificate {
    return this.cert
  }

  /**
   * Records a write into persistent memory made while the session carried
   * untrusted content.
   *
   * Recorded on every decision that may let the write happen: allow, a
   * rewrite (quarantine cut the verbatim fragment, a paraphrase may remain),
   * and ask — the human may say yes, and the hook never learns the answer.
   * Over-recording on a declined ask costs one question in a later session;
   * under-recording costs the attack. A deny never lands, so it carries
   * nothing.
   *
   * The condition is the session's marks, not a match against what is being
   * written: the attack that waits is the paraphrase that shares no byte with
   * the page, the same blindness the exposure rule answers within a session.
   * A match counts too, through the rewrite.
   *
   * One condition reaches past the current turn: content from outside read in
   * ANY earlier turn. The common shape of the attack is "read this page", an
   * answer, then "now save the key points" — the new message lifts the
   * exposure mark, yet the page is still in the context the note is written
   * from. Local files and shell output are left out of that look-back: every
   * file is untrusted by default, and counting them would put every ordinary
   * CLAUDE.md edit in a coding session under review.
   *
   * A failure to write the ledger is not caught: the exception reaches the
   * adapter, where a failed PreToolUse is a deny. The write then does not
   * happen, which is the only safe outcome of not being able to remember it.
   */
  private recordMemory(call: ToolCall, decision: Decision): void {
    if (decision.kind === 'deny') return
    if (this.policy.exposure === false) return
    const outside = this.taint.untrusted(FROM_OUTSIDE)[0]
    const marked = this.exposure !== null || this.unredacted || this.taint.saturated ||
      decision.kind === 'rewrite' || outside !== undefined
    if (!marked) return
    const target = memoryTarget(call, this.policy)
    if (target === null) return

    const source = this.exposure?.source ?? outside?.label ?? this.lastSource?.label ??
      'a source that could not be read cleanly'
    this.ledger.record({ target, source, sessionId: this.sessionId })
    this.notifier.notify({
      at: new Date().toISOString(),
      decision: 'memory',
      tool: call.tool,
      reason:
        `memory ${target} is being written after reading untrusted content; every later session ` +
        'escalates consequential calls until you review it and say "cordon: trust memory"',
      source,
    })
  }

  /**
   * Starts the session marked when memory was written under exposure.
   *
   * The mark reuses the exposure rule whole — the same escalation, the same
   * exemption for destinations the user named — because the situation is the
   * same one: untrusted content is in the model's context. Only the way it
   * got there differs: through a file the harness reloads, not a tool result.
   */
  private carryMemory(): void {
    if (this.policy.exposure === false) return
    if (this.exposure !== null) return
    const live = this.ledger.live()
    if (live.length === 0) return
    this.exposure = { at: this.turn, source: describeMemory(live), memory: true }
  }

  private persist(): void {
    this.sessions.save(this.sessionId, {
      turn: this.turn,
      taint: this.taint,
      unredacted: this.unredacted,
      readIds: this.readIds,
      directive: this.directive,
      exposure: this.exposure,
      userAtoms: this.userAtoms,
      userNames: this.userNames,
      userWords: this.userWords,
      lookups: this.lookups,
      lookupsVoidAt: this.lookupsVoidAt,
      turnNames: this.turnNames,
    })
  }

  /**
   * A declared lookup's result: the names it binds, for the gate to read
   * this turn. `texts` are the pieces of the result as the model received
   * them, cleaned. A tool the policy does not declare binds nothing.
   */
  recordLookup(call: ToolCall, texts: readonly string[]): void {
    const lookups = this.policy.lookups ?? {}
    if (!Object.hasOwn(lookups, call.tool)) return
    const args = typeof call.args === 'object' && call.args !== null ? call.args as Record<string, unknown> : {}
    const found = readLookup(call.tool, lookups[call.tool]!, args, texts.join('\n'), this.turn)
    if (found === 'unreadable') {
      // What could not be read could have held the second record for a name:
      // the whole turn's bindings go, not only this result's.
      this.lookupsVoidAt = this.turn
      this.persist()
      return
    }
    if (found.length === 0) return
    this.lookups = [...this.lookups.filter((o) => o.turn === this.turn), ...found]
    // Past the cap the turn is voided rather than trimmed: the record that
    // would be dropped could be the second one that made a name ambiguous.
    if (this.lookups.length > MAX_LOOKUPS) {
      this.lookupsVoidAt = this.turn
      this.lookups = this.lookups.slice(-MAX_LOOKUPS)
    }
    this.persist()
  }

  /** Every argument name the policy declares controlled, on any tool. */
  private controlledFields(): string[] {
    const fields = new Set<string>()
    for (const roles of Object.values(this.policy.arguments ?? {})) {
      for (const [field, role] of Object.entries(roles)) if (role === 'controlled') fields.add(field)
    }
    return [...fields]
  }

  private vouched(): ReadonlySet<string> {
    const said = new Set(this.turnNames.turn === this.turn ? this.turnNames.names : [])
    return vouched(this.lookups, this.lookupsVoidAt === this.turn, said, this.policy.lookups ?? {}, this.turn)
  }

  /**
   * What the human named in their own words: atoms, and separately names
   * (`provenance/names.ts`). Two lists with a cap each, because a chatty
   * message yields many names, and in one list they would push out the links
   * and identifiers the taint rule also reads. The cap drops the oldest
   * first: a destination named long ago expires before a list can grow
   * without bound.
   */
  private rememberNamed(text: string): void {
    const current = this.turnNames.turn === this.turn ? this.turnNames : { turn: this.turn, names: [] }
    const said = new Set([...current.names, ...names(text), ...atoms(text)])
    const assigned = new Set([
      ...(current.assigned ?? []),
      ...assignments(text, this.controlledFields()).map((pair) => JSON.stringify(pair)),
    ])
    this.turnNames = {
      turn: this.turn,
      names: [...said].slice(-MAX_USER_ATOMS),
      assigned: [...assigned].slice(-MAX_USER_ATOMS),
    }
    for (const atom of [...atoms(text), ...pastedSecrets(text)]) {
      if (!this.userAtoms.includes(atom)) this.userAtoms.push(atom)
    }
    for (const name of names(text)) {
      if (!this.userNames.includes(name)) this.userNames.push(name)
    }
    if (this.userAtoms.length > MAX_USER_ATOMS) this.userAtoms = this.userAtoms.slice(-MAX_USER_ATOMS)
    for (const word of words(text)) {
      if (!this.userWords.includes(word)) this.userWords.push(word)
    }
    if (this.userNames.length > MAX_USER_ATOMS) this.userNames = this.userNames.slice(-MAX_USER_ATOMS)
    if (this.userWords.length > MAX_USER_ATOMS) this.userWords = this.userWords.slice(-MAX_USER_ATOMS)
  }
}

/**
 * Source kinds that bring content from outside the machine: a page, a tool or
 * MCP server's result. What the memory rule looks back for across turns.
 */
const FROM_OUTSIDE: ReadonlySet<Source['kind']> = new Set<Source['kind']>(['web', 'tool', 'mcp-description'])

/** The mark's source line, which is what the human reads in the refusal. */
function describeMemory(entries: readonly MemoryEntry[]): string {
  const targets = [...new Set(entries.map((entry) => entry.target))]
  const shown = targets.length > 3 ? `${targets.slice(0, 3).join(', ')} and ${targets.length - 3} more` : targets.join(', ')
  const sources = [...new Set(entries.map((entry) => entry.source))].slice(0, 3).join(', ')
  return `memory ${shown} was written after reading ${sources}; review it, then say "cordon: trust memory"`
}

/** What changed between the context a question was asked in and this one. */
export function changed(earlier: ApprovalContext | null, now: ApprovalContext): string {
  if (earlier === null) return 'in a context that was not recorded'
  if (earlier.exposure === null && now.exposure !== null) return `before this session read untrusted content (${now.exposure})`
  if (earlier.exposure !== now.exposure) return `while the session carried different untrusted content (${earlier.exposure ?? 'none'})`
  if (earlier.policy !== now.policy) return 'under a policy that has changed since'
  if (earlier.rule !== now.rule) return `under another rule (${earlier.rule}, now ${now.rule})`
  if (earlier.turn !== now.turn) return 'before your latest message'
  if (earlier.reads !== now.reads) return 'before the session read more untrusted content'
  return 'in a different context: the certificate or what was read has changed'
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
