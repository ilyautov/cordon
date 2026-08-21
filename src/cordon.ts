import { humanSeesRendered, type Certificate, type Decision, type EffectClass, type Source, type ToolCall } from './core/types.js'
import { gate as decide } from './gate/gate.js'
import { FileNotifier, SILENT, type Notifier } from './notify/notifier.js'
import type { Policy } from './policy/defaults.js'
import { atoms } from './provenance/normalize.js'
import { TaintStore } from './provenance/store.js'
import { sanitize } from './sanitize/index.js'
import type { Finding } from './sanitize/types.js'
import { issue, narrow, parseDirective } from './scope/certificate.js'
import { MAX_USER_ATOMS, SessionStore } from './session/store.js'

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
}

/**
 * The core's facade. Exactly three entries, matching the adapter contract of
 * three: trusted input, observing a tool result, deciding on a call.
 */
/**
 * What a piece of a tool's result is: something the source wrote, or something
 * it merely labelled. Only the first goes into provenance.
 */
export type PieceRole = 'content' | 'label'

export class Cordon {
  private readonly policy: Policy
  private readonly cordonHome: string
  private readonly notifier: Notifier
  private readonly sessions: SessionStore
  private readonly taint: TaintStore
  private cert: Certificate
  private turn = 0
  private unredacted = false
  private directive: EffectClass[] | null = null
  private lastSource: Source | null = null
  /**
   * The session read untrusted content after the last user message. The mark
   * keys the gate's decision on the FACT of the read, not on a match against
   * what was read: the battery measured that the paraphrase/encoding tail of
   * attacks shares no recorded byte with its arguments, so provenance stays
   * silent there by construction.
   */
  private exposure: { at: number; source: string } | null = null
  /**
   * Atoms from the user's own messages. A call under the exposure mark passes
   * when the user themselves named every one of its targets — the destination
   * came from the human, not from the page.
   */
  private userAtoms: string[] = []

  /** The state key on disk. It comes from the harness, that is, from outside. */
  readonly sessionId: string

  constructor(options: CordonOptions) {
    this.policy = options.policy
    this.cordonHome = options.cordonHome
    this.notifier = options.notifier ?? (options.policy.notify.file
      ? new FileNotifier(options.policy.notify.file)
      : SILENT)

    this.sessionId = options.sessionId ?? 'default'
    this.sessions = new SessionStore(this.cordonHome)
    // A broken state arrives here as an exception and leaves as one: catching
    // it here would mean starting the session with clean provenance, that is,
    // with the most permissive state, right after the file was corrupted.
    const restored = this.sessions.load(this.sessionId)
    this.turn = restored.turn
    this.taint = restored.taint
    this.unredacted = restored.unredacted === true
    this.exposure = restored.exposure ?? null
    this.userAtoms = restored.userAtoms ?? []

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
    for (const atom of atoms(text)) {
      if (!this.userAtoms.includes(atom)) this.userAtoms.push(atom)
    }
    // The cap drops the oldest names first: a destination named long ago
    // expires before the list can grow without bound.
    if (this.userAtoms.length > MAX_USER_ATOMS) {
      this.userAtoms = this.userAtoms.slice(-MAX_USER_ATOMS)
    }

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
   * `role` separates two questions that are not the same one. Everything the
   * source put in front of the model is cleaned, without exception. Only what
   * the source authored is recorded as provenance: a heading, a name or the
   * query echoed back are the values the user hands over as arguments a moment
   * later, and recording those would declare the user's own words untrusted.
   * A miss in provenance costs one unmarked value; false taint there stops
   * work that was never an attack, and stops it quietly.
   */
  observe(text: string, source: Source, role: PieceRole = 'content'): Envelope {
    const { clean, findings } = sanitize(text)
    const substitute = humanSeesRendered(source)
    if (role === 'content') {
      this.taint.record(clean, source)
      if (!substitute && clean !== text) this.taint.record(text, source)
      // The fact of the read is marked apart from what was read: an attack
      // whose arguments share no byte with the page (a paraphrase, an
      // encoding, a clean curl command) leaves provenance silent, and the
      // mark is what the gate answers to there. Labels do not count: a
      // heading the source wrote ABOUT the content is not the content the
      // model read — recording those would mark the session for the user's
      // own values echoed back.
      if (source.trust === 'untrusted') this.exposure = { at: this.turn, source: source.label }
    }
    if (source.trust === 'untrusted') this.lastSource = source
    this.persist()
    return { text: clean, source, findings, substitute }
  }

  gate(call: ToolCall): Decision {
    const decision = decide(call, {
      policy: this.policy,
      cert: this.cert,
      taint: this.taint,
      cordonHome: this.cordonHome,
      turn: this.turn,
      unredacted: this.unredacted,
      exposure: this.exposure,
      userAtoms: this.userAtoms,
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
    if (decision.kind === 'deny' || decision.kind === 'ask' || decision.kind === 'rewrite') {
      this.notifier.notify({
        at: new Date().toISOString(),
        decision: decision.kind,
        tool: call.tool,
        reason: decision.reason,
        source: this.lastSource?.label ?? null,
      })
    }

    return decision
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
    for (const atom of atoms(text)) {
      if (!this.userAtoms.includes(atom)) this.userAtoms.push(atom)
    }
    // The same cap as for user messages, and the same order: the oldest
    // names expire first.
    if (this.userAtoms.length > MAX_USER_ATOMS) {
      this.userAtoms = this.userAtoms.slice(-MAX_USER_ATOMS)
    }
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

  certificate(): Certificate {
    return this.cert
  }

  private persist(): void {
    this.sessions.save(this.sessionId, {
      turn: this.turn,
      taint: this.taint,
      unredacted: this.unredacted,
      directive: this.directive,
      exposure: this.exposure,
      userAtoms: this.userAtoms,
    })
  }
}
