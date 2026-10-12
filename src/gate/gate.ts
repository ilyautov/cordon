import { resolve, sep } from 'node:path'
import type { ArgumentRole, Certificate, Decision, EffectClass, ExposureMark, Source, ToolCall } from '../core/types.js'
import { fields, type Field } from './fields.js'
import { secretKinds } from './secrets.js'
import { memoryTarget } from './memory.js'
import type { Rule } from './rules.js'
import type { Policy } from '../policy/defaults.js'
import { destinationPattern } from '../policy/destinations.js'
import { canonicalForms, fold as foldSegment, touchesCordonItself } from '../policy/selfprotect.js'
import { vouchKey } from '../provenance/bindings.js'
import { atoms } from '../provenance/normalize.js'
import type { TaintStore } from '../provenance/store.js'
import { covers } from '../scope/certificate.js'
import { classify } from '../scope/effects.js'
import { quarantine } from './quarantine.js'
import { COMMAND_KEYS, PATH_KEYS, URL_KEYS, fold, roleOf } from '../core/argument-keys.js'
import { safeLabel } from '../output/footer.js'

export interface GateContext {
  policy: Policy
  cert: Certificate
  taint: TaintStore
  cordonHome: string
  turn: number
  /**
   * In this session a hidden layer could not be stripped from a tool result:
   * the output shape turned out to be unfamiliar. The field is optional
   * because the absence of the mark is its normal state.
   */
  unredacted?: boolean
  /**
   * The session read untrusted content after the last user message: the turn
   * of the read and the source's label. Optional because the absence of the
   * mark is its normal state.
   */
  exposure?: ExposureMark | null
  /**
   * Atoms — links, paths, identifiers — named by the user in their own
   * messages. The exposure exemption compares a call's targets against this
   * list and against nothing else: a destination written inside untrusted
   * content vouches for nothing, however it is phrased.
   */
  userAtoms?: readonly string[]
  /**
   * Names the user wrote (`provenance/names.ts`). Read by the exposure rule
   * only: a name is a destination the user pointed at, and nothing else here
   * treats it as anything.
   */
  userNames?: readonly string[]
  /** Words of the user's messages: a resource the user named. */
  userWords?: readonly string[]
  /**
   * Values a declared lookup bound to a name the user said, as `vouchKey`
   * spells them (`provenance/bindings.ts`). Each counts as named by the user
   * in that argument of that tool and nowhere else.
   */
  vouched?: ReadonlySet<string>
  /**
   * Values the user's current message assigned to controlled fields, each a
   * JSON pair of the field and the value (`provenance/assignments.ts`).
   */
  assigned?: ReadonlySet<string>
  /**
   * MCP tools held back because they changed or appeared after the owner
   * approved the server. Optional: only the MCP gateway lists tools.
   */
  heldTools?: ReadonlyMap<string, { why: 'changed' | 'new' | 'shadow'; server: string; imitates?: string }>
}

/**
 * Arguments whose value is a filesystem path.
 *
 * Names are folded to one form: `file_path`, `filePath` and `FILE-PATH` are
 * chosen by the MCP server and all mean the same thing.
 */

export function gate(call: ToolCall, ctx: GateContext): Decision {
  try {
    return decide(call, ctx)
  } catch (error) {
    // A core error is a deny. The only exception handler in the
    // whole module, and everything leads here.
    return { kind: 'deny', rule: 'failure', reason: `Cordon failure: ${(error as Error).message}` }
  }
}

function decide(call: ToolCall, ctx: GateContext): Decision {
  if (typeof call?.tool !== 'string' || call.tool === '') {
    return { kind: 'deny', rule: 'malformed', reason: 'a call without a tool name' }
  }
  const args: unknown = call.args
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { kind: 'deny', rule: 'malformed', reason: `the arguments of call ${call.tool} did not arrive as an object` }
  }
  const own = args as Record<string, unknown>

  // Before everything else: the model was never shown this tool, so a call
  // to it came from a description it read elsewhere or a name it guessed.
  const held = ctx.heldTools?.get(call.tool)
  if (held !== undefined && held.why === 'shadow') {
    return {
      kind: 'deny',
      rule: 'pin',
      reason: `the MCP tool ${call.tool} imitates ${held.imitates ?? 'another server\'s tool'} with lookalike characters ` +
        `(${held.server}); approving the server does not release it, remove the server or ask its author to rename the tool`,
    }
  }
  if (held !== undefined) {
    return {
      kind: 'deny',
      rule: 'pin',
      reason: `the MCP tool ${call.tool} ${held.why === 'new' ? 'appeared' : 'changed'} after the server was approved ` +
        `(${held.server}); review the server, then run "cordon mcp approve -- ${held.server}"`,
    }
  }

  // The owner can grant exec to a restricted runner without granting the
  // harness's native shell. This is a hard refusal, not an interactive question:
  // an approval would reopen the host path the owner meant to remove.
  if (ctx.policy.blockedTools.includes(call.tool)) {
    return { kind: 'deny', rule: 'tool-blocked', reason: `tool ${call.tool} is blocked by the policy` }
  }

  const parts = fields(own)

  const selfHit = selfProtection(parts, ctx)
  if (selfHit) return selfHit

  const verdict = classify(call, ctx.policy.tools)

  // The hidden layer was not fully stripped, which means the model read
  // poisoned text. Reading further is not dangerous; acting on what was read
  // is dangerous exactly to the extent that we do not know what it read.
  if (ctx.unredacted === true || ctx.taint.saturated) {
    const harmless = verdict.classified
      && verdict.effects.every((effect) => effect === 'read' || effect === 'summarize')
    // Two different blindnesses, one consequence. Either the model read text
    // we could not clean, or it read more than we can remember — and in both
    // cases what we do not know is what it read. Reading on is safe; acting on
    // it is dangerous exactly to that extent.
    if (!harmless) {
      return escalate(
        ctx,
        ctx.unredacted === true ? 'unscanned' : 'saturation',
        ctx.unredacted === true
          ? 'a hidden layer in a tool result could not be stripped'
          : 'provenance is full: this session read more than the store holds, and stopped remembering',
      )
    }
  }

  if (!verdict.classified) {
    return escalate(ctx, 'unclassified', verdict.reason)
  }

  const coverage = covers(ctx.cert, verdict.effects)
  if (!coverage.ok) {
    return escalate(ctx, 'certificate', coverage.reason)
  }

  // Resource boundaries come after effect classes and before the taint
  // check: a call outside a declared boundary is refused regardless of how
  // clean its arguments are. Taint is irrelevant here; the right is missing
  // by location alone.
  const outside = outOfBounds(parts, ctx.cert)
  if (outside) {
    return escalate(ctx, 'bounds', outside)
  }

  const config = agentConfigWrite(verdict.effects, parts, ctx)
  if (config) {
    return escalate(ctx, 'agent-config', config, ctx.exposure?.source)
  }

  // A credential leaving the machine answers before provenance: it needs no
  // page to be dangerous. The reason names the kind and never the value, so
  // the key does not travel on into the journal or the model's context.
  const leaving = credentialLeaving(verdict.effects, parts, ctx.userAtoms ?? [])
  if (leaving) {
    return escalate(ctx, 'credential', leaving)
  }

  // Before provenance, so that no exit below can carry the call past it: a
  // quarantine rewrite kept the repository an outside review aimed it at.
  const bound = boundBy(call.tool, own, ctx)
  const stray = strayResource(call.tool, parts, ctx, bound)
  if (stray) return escalate(ctx, 'resource', stray, ctx.exposure?.source)
  // Before provenance for the same reason: a write back to the file read, or
  // a quarantine rewrite, carried an attacker's amount through untouched
  // (Codex). A target the user named, or a lookup vouched for, says where the
  // call goes and nothing about what it changes there.
  const loose = uncontrolled(call.tool, verdict.effects, parts, ctx)
  if (loose) return escalate(ctx, 'controlled', loose, ctx.exposure?.source)

  const scan = scanTaint(parts, ctx.taint, ctx.userAtoms ?? [], bound)
  if (!scan.tainted) {
    const exposed = exposedCall(call.tool, verdict.effects, parts, ctx, bound)
    if (exposed) return escalate(ctx, ctx.exposure?.memory === true ? 'memory-carry' : 'exposure', exposed, ctx.exposure?.source)
    return { kind: 'allow' }
  }

  // Which page aimed the call, for the owner's journal: the sources the
  // arguments matched, not whichever page happened to be read last.
  const blamedLabels = scan.sources.map((source) => source.label)
  const blamed = blamedLabels.join(', ') || undefined

  // The data axis answers differently in different cases, and that is not a
  // concession but a condition of usability. An agent that read a document
  // must be able to summarize it, quote it and answer from it. If any match
  // against what was read goes to quarantine, work stops at the first
  // meaningful action, and Cordon gets switched off before it protects
  // anything.
  //
  // We distinguish not by match length but by the cost of the error and by
  // what matched. An irreversible or outward-facing effect always answers. A
  // reversible one answers only to a target: a link, a path, an identifier —
  // that is, to whatever the attacker uses to aim the action.
  if (!verdict.effects.some((effect) => IRREVERSIBLE.has(effect))) {
    const targets = scan.targets.filter((atom) => !isDate(atom))
    if (targets.length === 0 || identifierReadUnderMark(verdict.effects, targets, ctx)) {
      const exposed = exposedCall(call.tool, verdict.effects, parts, ctx, bound)
      if (exposed) return escalate(ctx, ctx.exposure?.memory === true ? 'memory-carry' : 'exposure', exposed, ctx.exposure?.source)
      return { kind: 'allow' }
    }
    return escalate(ctx, 'provenance', `an argument carries a target from an untrusted source: ${targets.map(safeLabel).join(', ')}`, blamed)
  }

  // Content returning to the very source it was read from is not subject to
  // quarantine. There is no leak here by definition: the text goes exactly
  // where it came from, and after the write the world knows no more about it
  // than before. Without this exemption the ordinary cycle "read a file, edit
  // it, write it back" ends in a refusal or, worse, in silent corruption of
  // the file by excision, and Cordon becomes unusable for working with
  // files.
  if (returnsToOrigin(scan.sources, parts, verdict.effects)) return { kind: 'allow' }

  // There is nothing to cut taint out of a nested structure with: quarantine
  // works on a whole string argument, and we cannot parse somebody else's
  // argument schema. Hence escalation.
  if (scan.nested) {
    return escalate(ctx, 'provenance', `quarantine is impossible: the untrusted fragment sits inside a nested argument${origin(blamedLabels)}`, blamed)
  }

  // A memory file is the one place a silent cut costs most: the harness
  // reloads it into every later session, and the model reports having written
  // what it asked for. Measured on a live Claude Code — a summary came out of
  // quarantine mangled and nobody but the journal knew. So a write into memory
  // that would be cut is put to the human whole instead.
  const memory = memoryTarget(call, ctx.policy)
  if (memory !== null) {
    return escalate(
      ctx,
      'memory-write',
      `an untrusted fragment would be cut out of a write into memory (${memory}); ` +
        'a note the harness reloads is not rewritten silently',
      blamed,
    )
  }

  // The same for a message that leaves the machine. Cut, an email or a
  // payment memo reaches a stranger with a hole in it while the model reports
  // it sent whole; AgentDojo lost tasks exactly so, a quote cut out of the
  // body of an email. A local file can be looked at and fixed; a sent message
  // cannot. The owner is shown the draft whole instead.
  if (verdict.effects.some((effect) => OUTWARD.has(effect))) {
    return escalate(
      ctx,
      'provenance',
      `an untrusted fragment would be cut out of a call that leaves the machine${origin(blamedLabels)}; ` +
        (ctx.policy.mode === 'interactive'
          ? 'it is not sent with a piece cut out — read the whole draft and decide'
          : 'it is not sent with a piece cut out, and with nobody to read the draft it is refused'),
      blamed,
    )
  }

  const cleaned = quarantine(own, scan.spans)
  if (!cleaned.possible) {
    return escalate(ctx, 'provenance', `quarantine is impossible: ${cleaned.reason}${origin(blamedLabels)}`, blamed)
  }

  // Taint in one field must never lower what the whole call answers to. A
  // clean call after an untrusted read answers to the exposure rule; the same
  // call with a recorded paragraph pasted into a side field (a shell
  // command's description) was quarantined instead, and the rewrite ran the
  // command untouched (Codex). So the exposure rule is asked here too,
  // last, just before a rewrite would let the call through, so every more
  // specific refusal above keeps its own reason. The write back to the file
  // read stays exempt: nothing leaves, by definition.
  const exposedToo = exposedCall(call.tool, verdict.effects, parts, ctx, bound)
  if (exposedToo) {
    return escalate(ctx, ctx.exposure?.memory === true ? 'memory-carry' : 'exposure', exposedToo, ctx.exposure?.source)
  }

  // A shell command is run, not read. Cutting a paragraph out of the
  // description that came with it runs the command the owner never saw
  // described (Codex); the command itself is indivisible in quarantine
  // already, and the call around it is judged whole the same way.
  if (verdict.effects.includes('exec')) {
    return escalate(
      ctx,
      'provenance',
      `an untrusted fragment would be cut out of a shell command${origin(blamedLabels)}; it is not run with a piece cut out`,
      blamed,
    )
  }

  return {
    kind: 'rewrite',
    rule: 'provenance',
    args: cleaned.args,
    removed: cleaned.removed,
    reason: 'an untrusted fragment was cut out of the arguments',
    ...(blamed === undefined ? {} : { source: blamed }),
  }
}

/**
 * Checked first and overridden by nothing. A certificate granting the right
 * to write anywhere still does not grant the right to switch off the checker.
 */
function selfProtection(parts: readonly Field[], ctx: GateContext): Decision | null {
  for (const { key, value } of parts) {
    const folded = fold(key)

    if (PATH_KEYS.has(folded)) {
      const paths = asPaths(value)
      // An object with its own toString() is not a string, but the harness
      // will coerce it to one when calling. We will not reason about somebody
      // else's coercion: a path of unclear shape is a refusal.
      if (paths === null) {
        return { kind: 'deny', rule: 'self-protection', reason: `self-protection: argument ${key} is not a path` }
      }
      for (const path of paths) {
        if (touchesCordonItself(path, ctx.cordonHome)) {
          return { kind: 'deny', rule: 'self-protection', reason: `self-protection: ${path} belongs to Cordon or to the harness` }
        }
      }
    }

    // A shell can do everything a file tool can, only bypassing the path
    // argument: `echo "mode: off" > ~/.cordon/policy.yaml`. Parsing the shell
    // command here is not an option, every shell parser can be worked around.
    // So the check is crude, by substring, and declared incomplete: assembly
    // from variables, brace expansion, `..` segments, and quotes, globs or a
    // POSIX backslash escape placed inside a marker (`.claude\/settings`) get
    // around it. Resolving escapes would refuse sed idioms that only carry the
    // text (Codex and Kimi, reviewing the connectors). It closes the direct
    // case; full closure comes only from the absence of `exec` in the
    // certificate.
    if (COMMAND_KEYS.has(folded) && typeof value === 'string') {
      // An approval is the owner's word, and a shell can say it for them:
      // a pending call approved, a changed MCP server re-pinned. The same
      // substring crudeness as below, and the same answer to its limit.
      if (APPROVES.test(value.replace(/["'\\]/gu, ''))) {
        return { kind: 'deny', rule: 'self-protection', reason: 'self-protection: the command approves, writes a policy or speaks as the harness, which only the owner may do' }
      }
      // Case-folded: macOS and Windows open .CODEX as .codex, and a check
      // that compared exactly let the capitals through (Codex, reviewing
      // the Kimi and DeepSeek connectors).
      // Folded once, not per marker: a ten-megabyte command folded nine
      // times outran the hook's timeout (Codex, reviewing the connectors).
      const windows = sep === '\\'
      const command = foldCommand(value.toLowerCase(), windows)
      for (const marker of selfMarkers(ctx.cordonHome)) {
        if (mentions(command, foldCommand(marker.toLowerCase(), windows))) {
          return { kind: 'deny', rule: 'self-protection', reason: `self-protection: the command mentions ${marker}` }
        }
      }
    }
  }

  return null
}

/**
 * Agent configuration a project keeps outside the harness directories, which
 * self-protection already closes. These are edited by people all the time, so
 * they stay writable; after an untrusted read they are not, whoever named the
 * path. CVE-2025-53773: an injection wrote `chat.tools.autoApprove` into
 * .vscode/settings.json and ran commands unconfirmed. CVE-2025-54135: an
 * injection rewrote mcp.json and the new server started on its own.
 */
const AGENT_CONFIG: readonly (readonly string[])[] = [
  ['.vscode', 'settings.json'], ['.vscode', 'tasks.json'], ['.vscode', 'mcp.json'], ['.vscode', 'launch.json'],
  ['.mcp.json'], ['.windsurf', 'mcp.json'], ['.continue', 'config.json'], ['.zed', 'settings.json'],
  ['.zed', 'tasks.json'],
  // Not an agent's, but it runs commands when the container is built, the
  // same shape as a folder-open task.
  ['.devcontainer', 'devcontainer.json'],
]
const CONFIG_WRITES: ReadonlySet<EffectClass> = new Set(['create', 'update', 'delete'])

function agentConfigWrite(effects: readonly EffectClass[], parts: readonly Field[], ctx: GateContext): string | null {
  if (ctx.exposure === undefined || ctx.exposure === null) return null
  const exec = effects.includes('exec')
  if (!exec && !effects.some((effect) => CONFIG_WRITES.has(effect))) return null
  const refuse = (hit: readonly string[]): string =>
    `this session read untrusted content (${ctx.exposure!.source}); ${hit.join('/')} is agent configuration, ` +
    'and a page that edits it can switch confirmations off or start a server — edit it yourself, or ask again after your next message'
  for (const { key, value } of parts) {
    const folded = fold(key)
    if (PATH_KEYS.has(folded)) {
      for (const path of asPaths(value) ?? []) {
        for (const form of canonicalForms(path)) {
          const hit = configTail(form)
          if (hit !== undefined) return refuse(hit)
        }
      }
    }
    // A shell reaches the same files with `>` or `tee`, and what a command
    // does cannot be read off it; which files it names can. Naming one under
    // the mark counts as writing it, as for memory files.
    if (exec && COMMAND_KEYS.has(folded) && typeof value === 'string') {
      for (const raw of value.split(/[\s;&|<>()`=]+/u)) {
        const hit = configTail(raw.replace(/["'\\]/gu, ''))
        if (hit !== undefined) return refuse(hit)
      }
    }
  }
  return null
}

function configTail(path: string): readonly string[] | undefined {
  if (path === '') return undefined
  const segments = path.split(/[\\/]/u).map(foldSegment)
  return AGENT_CONFIG.find((tail) =>
    tail.length <= segments.length && tail.every((part, offset) => segments[segments.length - tail.length + offset] === part),
  )
}

/**
 * The value of a path argument as a list of paths.
 *
 * null means "not a path": scalars such as a number are harmless and pass,
 * while an object, a function or a mixed list are not.
 */
function asPaths(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (value === null || value === undefined) return []
  if (typeof value === 'number' || typeof value === 'boolean') return []
  if (Array.isArray(value)) {
    const paths: string[] = []
    for (const item of value) {
      const nested = asPaths(item)
      if (nested === null) return null
      paths.push(...nested)
    }
    return paths
  }
  return null
}

/** Substrings whose mention in a shell command means an attempt to reach Cordon. */
/**
 * The owner's verbs and the harness's: `cordon approve`, `cordon mcp
 * approve`, `cordon init`, `cordon policy apply` and `cordon hook`, and the
 * same through the bundle's path. `init --force` rewrites policy.yaml without
 * naming it, so no path marker sees it. `hook` takes the user's message on
 * stdin, and run by the agent it is a forged user turn; the harness runs the
 * hook itself, never through the agent's shell.
 */
const APPROVES = /(?:\bcordon(?:@[\w.^~-]+)?|\bcli\.m?js)\s+(?:(?:mcp\s+)?approve|init|policy\s+apply|hook)\b/iu

/**
 * A command's paths spelled the way the platform the harness runs on reads
 * them, in one linear pass. On Windows both slashes separate and a segment's
 * trailing dots and spaces are dropped, so `.claude.\hooks` is `.claude/hooks`;
 * on POSIX a backslash is an escape, and folding it refused a sed idiom that
 * only carried the text. On both, `//` and a `.` segment collapse. Four review
 * rounds patched the comparison one spelling at a time; this is the model
 * they were circling (Codex and Kimi, reviewing the connectors).
 */
export function foldCommand(command: string, windows: boolean): string {
  const out: string[] = []
  let segment = 0
  for (const char of command) {
    if (char !== '/' && !(windows && char === '\\')) {
      out.push(char)
      continue
    }
    if (windows) {
      while (out.length > segment && (out[out.length - 1] === '.' || out[out.length - 1] === ' ')) out.pop()
    } else if (out.length === segment + 1 && out[segment] === '.') {
      out.pop()
    }
    if (out[out.length - 1] !== '/') out.push('/')
    segment = out.length
  }
  return out.join('')
}

/**
 * Whether a folded command names a folded marker. A marker with a `/` in it
 * is a path prefix and matches as one. A bare directory name followed by a
 * letter, a digit or `_`, after any dots, is part of another name: `.kimi` in
 * www.kimi.com is the harness's site, and the substring refused every command
 * that fetched it (Kimi, reviewing the connectors). `-` still counts, so
 * `.kimi` covers `.kimi-code`; a glob character counts too. The dots are
 * skipped on every platform: a `.dsh.` at the end of a word is `.dsh` on
 * Windows, and elsewhere the stricter reading costs nothing real.
 */
export function mentions(command: string, marker: string): boolean {
  if (marker.includes('/')) return command.includes(marker)
  for (let at = command.indexOf(marker); at !== -1; at = command.indexOf(marker, at + 1)) {
    if (!/^\.*[\p{L}\p{N}_]/u.test(command.slice(at + marker.length))) return true
  }
  return false
}

function selfMarkers(cordonHome: string): string[] {
  // '.kimi' covers '.kimi-code' too. The file tools read HARNESS_CONFIG in
  // src/policy/selfprotect.ts; a directory added there and not here was
  // reachable through the shell (Codex, reviewing the Kimi and DeepSeek
  // connectors).
  return [cordonHome, '.cordon', '.claude/settings', '.claude/hooks', '.cursor', '.codex', '.gemini', '.kimi', '.dsh']
}

function escalate(ctx: GateContext, rule: Rule, reason: string, source?: string): Decision {
  const kind = ctx.policy.mode === 'interactive' ? 'ask' : 'deny'
  return source === undefined ? { kind, rule, reason } : { kind, rule, reason, source }
}

/**
 * The exposure rule: the session read untrusted content since the user's last
 * message, and the call acts beyond reading. It fires ONLY on paths that
 * would otherwise return allow — where a certificate, bounds or taint check
 * already escalated, its reason says more than this one would.
 *
 * The exemption is by destination, not by payload: a call passes when EVERY
 * atom of its arguments was named by the user in their own messages. A call
 * with no atoms at all does not pass vacuously — `npm test` after reading a
 * poisoned page escalates too: a shell command is not parsed (a declared
 * limit), so there is no telling an identifier-free command from an attack,
 * and the error must run towards the question.
 *
 * The declared hole, honestly: a payload PARAPHRASED onto a destination the
 * user did name is invisible here — the exemption looks at where the call
 * goes, not at what it carries, and matching the retold text to what was read
 * is the string-matching ceiling this mechanism exists to bypass. That
 * residue is what resource bounds (hosts/paths in the certificate) are for.
 */
function exposedCall(
  tool: string,
  effects: readonly EffectClass[],
  parts: readonly Field[],
  ctx: GateContext,
  bound: (field: Field) => boolean,
): string | null {
  // The valve: a policy that says exposure: false asks for exactly the
  // pre-exposure behaviour, and doctor names the price of that out loud.
  if (ctx.policy.exposure === false) return null
  const exposure = ctx.exposure
  if (exposure === undefined || exposure === null) return null

  if (!effects.some((effect) => EXPOSURE_SENSITIVE.has(effect))) return null

  // The call's targets are the atoms of its arguments, extracted by the same
  // function that extracts them from the user's messages: a link or an
  // identifier must mean the same token on both sides of the comparison, or
  // the exemption would hinge on a spelling difference. A date is not a
  // target here either, for the same reason as in the taint rule: it matches
  // by coincidence and cannot be used to aim an action.
  const targets = new Set<string>()
  for (const part of parts) {
    const { value } = part
    if (typeof value !== 'string' || bound(part)) continue
    for (const atom of atoms(value)) {
      if (!isDate(atom)) targets.add(atom)
    }
  }
  const named = new Set(ctx.userAtoms ?? [])
  const mandate = ctx.policy.destinations ?? []
  // The mandate names where a task sends things, and a command is not sent
  // anywhere: `rm -rf build # ops@acme.example` matched a mandated address
  // in its comment. The user's own atoms still count for exec.
  const mandateApplies = !effects.includes('exec')
  const allNamed = [...targets].every((atom) => named.has(atom) || (mandateApplies && inMandate(atom, mandate)))
  if (targets.size > 0 && allNamed) return null
  // A field whose whole value is a name the user wrote — "send it to Alice"
  // — is a destination the user named, as a link or an address would be.
  // The rest of the call still answers: every atom must be named too. A mark
  // carried in from memory is not lifted by it: the note was written in an
  // earlier session under a page's influence, and a name said in this one
  // does not vouch for what the note asks.
  if (
    exposure.memory !== true && allNamed && !effects.includes('exec') &&
    namesADestination(tool, parts, ctx.userNames ?? [], mandate, ctx.policy.arguments ?? {}, bound)
  ) return null

  if (exposure.memory === true) {
    return (
      `untrusted content is back in this session through memory (${exposure.source}); ` +
      'the call acts beyond reading and its destination was not named by you'
    )
  }
  return (
    `this session read untrusted content (${exposure.source}) since your last message; ` +
    'the call acts beyond reading and its destination was not named by you — ' +
    'name the destination in your message, or declare it under destinations in the policy'
  )
}

/**
 * Under the exposure mark, the first controlled field whose value the user's
 * current message did not assign, as a refusal; otherwise null.
 *
 * Any depth, and by the key folded the way every other argument name is: a
 * controlled amount inside an object is still the amount, and `Amount` is
 * `amount` to a server that folds case (Kimi). A value that is not a string
 * or a finite number is refused rather than read as absent. A string must be
 * the assigned value exactly. A number must be exactly the number the user
 * wrote: 1,200.50 is 1200.5, 0 is not -0, and an integer past 2^53, which a
 * double cannot hold, matches nothing.
 */
function uncontrolled(tool: string, effects: readonly EffectClass[], parts: readonly Field[], ctx: GateContext): string | null {
  if (ctx.policy.exposure === false) return null
  const exposure = ctx.exposure
  if (exposure === undefined || exposure === null) return null
  if (!effects.some((effect) => EXPOSURE_SENSITIVE.has(effect))) return null
  const declared = Object.hasOwn(ctx.policy.arguments ?? {}, tool) ? ctx.policy.arguments![tool]! : {}
  const controlled = new Map<string, string>()
  for (const [field, role] of Object.entries(declared)) if (role === 'controlled') controlled.set(fold(field), field)
  if (controlled.size === 0) return null
  const assigned = [...(ctx.assigned ?? [])].map((pair) => JSON.parse(pair) as [string, string])
  for (const { key, value } of parts) {
    const field = controlled.get(fold(key))
    if (field === undefined) continue
    const stated = assigned.filter(([name]) => name === field).map(([, text]) => text)
    if (!stated.some((text) => matches(value, text))) {
      return (
        `this session read untrusted content (${exposure.source}); the call sets ${field} ` +
        `to a value you did not state in your message — write it out, for example ${field} to …`
      )
    }
  }
  return null
}

/** Whether a call's value is exactly what the user wrote for the field. */
function matches(value: unknown, stated: string): boolean {
  if (typeof value === 'string') return value.trim() === stated
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(stated)) return false
  const number = Number(stated)
  if (!stated.includes('.') && !Number.isSafeInteger(number)) return false
  return Object.is(number, value)
}

/**
 * The resource rule, answered before anything else under the mark. A read of
 * a resource the user never named is the step that matters: GitHub's MCP
 * server was led from an issue in the public repository the user asked about
 * into their private ones, and every call on the way was a read or aimed at
 * the named repository.
 */
function strayResource(
  tool: string,
  parts: readonly Field[],
  ctx: GateContext,
  bound: (field: Field) => boolean,
): string | null {
  if (ctx.policy.exposure === false) return null
  const exposure = ctx.exposure
  if (exposure === undefined || exposure === null) return null
  const stray = unnamedResource(tool, parts, ctx, bound)
  if (stray === null) return null
  return (
    `this session read untrusted content (${exposure.source}); the call reaches ${safeLabel(stray)}, ` +
    'a resource you did not name — name it in your message, or add it to destinations in the policy'
  )
}

/**
 * Destination fields whose whole values the user said or the policy
 * declares. Only a destination: a name in Bash's `description` field vouched
 * for a whole command once. A shell command is never aimed by a name at all;
 * the caller keeps exec out.
 */
function namesADestination(
  tool: string,
  parts: readonly Field[],
  userNames: readonly string[],
  mandate: readonly string[],
  roles: Readonly<Record<string, Readonly<Record<string, ArgumentRole>>>>,
  bound: (field: Field) => boolean,
): boolean {
  const names = new Set(userNames)
  // Every destination the call names, at any depth: an element of
  // `recipients` carries its field's key. All of them must be named, so a
  // named Alice cannot carry an unnamed Eve along in the same list.
  // A number counts too: a file id is one as often as a string, and a bound
  // id vouches for it either way.
  const destinations = parts.filter(({ key, value }) =>
    (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) &&
    roleOf(tool, key, roles) === 'destination')
  return destinations.length > 0 && destinations.every((part) => {
    const whole = String(part.value).trim().normalize('NFKC').toLowerCase()
    return names.has(whole) || inMandate(whole, mandate) || bound(part)
  })
}

/**
 * Whether a field holds a value a declared lookup vouches for in this
 * argument of this tool. Only the argument itself or an element of its list,
 * checked by the container rather than by the key's name: a key buried in a
 * nested object is chosen by whoever built the object and names no argument
 * of the tool, even when a top-level list of the same name sits beside it.
 */
function boundBy(tool: string, own: Record<string, unknown>, ctx: GateContext): (field: Field) => boolean {
  const vouched = ctx.vouched
  if (vouched === undefined || vouched.size === 0) return () => false
  return ({ key, value, depth, holder }) => {
    // An id is a number as often as a string in a tool's schema; the lookup
    // side reads it the same way.
    const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
    if (text === null || !Object.hasOwn(own, key)) return false
    const argument = own[key]
    const inPlace = depth === 0 ? holder === own : depth === 1 && Array.isArray(argument) && holder === argument
    return inPlace && vouched.has(vouchKey(`${tool}.${key}`, text))
  }
}

/** A value the policy declares for the task: exact, or `*suffix`. */
function inMandate(value: string, mandate: readonly string[]): boolean {
  const whole = value.trim().normalize('NFKC').toLowerCase()
  return mandate.some((entry) => {
    const pattern = destinationPattern(entry)
    return pattern.startsWith('*') ? whole.endsWith(pattern.replace(/^\*+/u, '')) : whole === pattern
  })
}

/**
 * The first resource-role value the user did not name, at any depth: a word
 * of their messages, a name, an atom, or a segment of `owner/repo` that is
 * each of those. The policy's destinations name resources too.
 */
function unnamedResource(
  tool: string,
  parts: readonly Field[],
  ctx: GateContext,
  bound: (field: Field) => boolean,
): string | null {
  const said = new Set([...(ctx.userWords ?? []), ...(ctx.userNames ?? []), ...(ctx.userAtoms ?? [])])
  const mandate = ctx.policy.destinations ?? []
  for (const part of parts) {
    const { key, value } = part
    if (bound(part)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    if (roleOf(tool, key, ctx.policy.arguments ?? {}) !== 'resource') continue
    // `./sales.csv` is `sales.csv`: the current directory is no part of
    // the name the user said. `..` stays, since it leaves the directory.
    const whole = value.trim().normalize('NFKC').toLowerCase().replace(/^(?:\.\/)+/u, '')
    if (said.has(whole) || inMandate(whole, mandate)) continue
    const segments = whole.split('/').filter((segment) => segment !== '' && segment !== '.')
    if (segments.length > 1 && segments.every((segment) => said.has(segment))) continue
    return value
  }
  return null
}

/**
 * Effect classes that stay on the machine. Everything else hands its
 * arguments to someone: a read declared on an MCP search tool sends its query
 * to the server, and an outside review found a key going there unchallenged.
 */
const LOCAL_WRITES: ReadonlySet<EffectClass> = new Set(['create', 'update', 'delete'])

/**
 * A credential in a call that is more than a local write. A credential the
 * user pasted into their own message is theirs to send, so it is exempt,
 * compared in lower case as userAtoms hold it.
 */
function credentialLeaving(
  effects: readonly EffectClass[],
  parts: readonly Field[],
  userAtoms: readonly string[],
): string | null {
  if (effects.every((effect) => LOCAL_WRITES.has(effect))) return null
  const exempt = new Set(userAtoms)
  const kinds: string[] = []
  // Property names too: a JSON body is sent whole, keys included.
  for (const { key, value } of parts) {
    for (const text of typeof value === 'string' ? [key, value] : [key]) {
      for (const kind of secretKinds(text, exempt)) if (!kinds.includes(kind)) kinds.push(kind)
    }
  }
  if (kinds.length === 0) return null
  return `an argument carries what looks like a credential (${kinds.join(', ')}), and the call hands it to something outside the machine`
}

/**
 * Effect classes whose error cannot be undone: the action went outward or
 * changed the world. For them the cost of an extra question is certainly
 * lower than the cost of a miss, so taint of any kind means quarantine.
 */
const IRREVERSIBLE: ReadonlySet<EffectClass> = new Set([
  'network-egress',
  'financial',
  'delete',
  'update',
  'export',
  'exec',
])

/**
 * Effects whose result leaves the machine: a message, an export, a payment.
 * Quarantine does not cut these; a hole in a sent message cannot be mended.
 */
const OUTWARD: ReadonlySet<EffectClass> = new Set(['network-egress', 'export', 'financial'])

/**
 * The classes the exposure mark answers to: everything irreversible, plus
 * create. Create is reversible, and it is here because of the worm vector: a
 * page ordering a verbatim republication of its own paragraph ("post this
 * exact note") carries no target atom, so neither the taint rule nor the
 * certificate says anything about it — the battery measured it passing on
 * every profile that grants create. The mark closes it: after reading the
 * page, publishing anything is a consequential act whose destination the page
 * chose, not the user.
 *
 * The shape of the rule follows Progent (arXiv:2504.11703) and FIDES P-T
 * (arXiv:2505.23643): the policy narrows on the FACT of reading untrusted
 * content, and consequential calls are answered strictly out of an
 * all-trusted context — not on whether the arguments repeat what was read.
 *
 * Declared after IRREVERSIBLE and not above it: a module-level const spread
 * of a later const is a ReferenceError at load time, and a crashed hook reads
 * as permission on both harnesses.
 */
const EXPOSURE_SENSITIVE: ReadonlySet<EffectClass> = new Set([...IRREVERSIBLE, 'create'])

interface Scan {
  tainted: boolean
  /** Tainted spans, per top-level string argument. */
  spans: Record<string, Array<[number, number]>>
  /** Taint was found inside a nested structure; there is nothing to cut it with. */
  nested: boolean
  /** Atomic tokens from an untrusted source: links, paths, identifiers. */
  targets: string[]
  /**
   * Sources that matched in at least one argument.
   *
   * The list is aggregate rather than per argument: the return-to-origin
   * exemption is granted only when there are no foreign sources in the call
   * at all, and breaking it down per argument does not change that answer.
   */
  sources: Source[]
}

function scanTaint(
  parts: readonly Field[],
  taint: TaintStore,
  userAtoms: readonly string[],
  bound: (field: Field) => boolean = () => false,
): Scan {
  const named = new Set(userAtoms)
  const spans: Record<string, Array<[number, number]>> = {}
  const targets = new Set<string>()
  const sources = new Map<string, Source>()
  let tainted = false
  let nested = false

  for (const part of parts) {
    const { key, value, depth } = part
    if (typeof value !== 'string') continue
    // A value that is, whole, what the user named in their own message aims
    // nothing the user did not ask for, even when a page repeats it. AgentDojo
    // measured the cost: "refund GB29…" was refused because the same IBAN sat
    // in the transaction history. Only the whole value: a longer text around
    // the named value is still checked as usual.
    if (named.has(value.trim().toLowerCase())) continue
    // A value a declared lookup bound to a name the user said, in an argument
    // the policy lets it fill: the same as the user naming it.
    if (bound(part)) continue
    const match = taint.check(value)
    if (!match.tainted) continue

    tainted = true
    for (const atom of match.atoms) targets.add(atom)
    for (const source of match.sources) sources.set(source.id, source)
    if (depth === 0) {
      // The key name came from outside: assigning through `__proto__` would
      // replace the prototype rather than create a field.
      Object.defineProperty(spans, key, {
        value: match.spans,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    } else {
      nested = true
    }
  }

  return { tainted, spans, nested, targets: [...targets], sources: [...sources.values()] }
}

/**
 * Effect classes that carry content past the named path. Return to origin
 * proves nothing for them: there is a path in the arguments, but the text
 * goes somewhere else. The exemption does not extend to them.
 */
// Every outward effect, export included: a tool that writes the file back
// and exports it too took this exemption past the outward check (Codex).
const BEYOND_PATH: ReadonlySet<EffectClass> = new Set(['network-egress', 'financial', 'exec', 'export'])

/**
 * Effect classes that put content back. The exemption is specifically about
 * returning text to its source, so it is granted only to a call that writes
 * that text. Deleting the file the text was read from is not a return: there
 * nothing comes back, something disappears.
 */
const PUTS_BACK: ReadonlySet<EffectClass> = new Set(['create', 'update'])

/**
 * The content returns exactly where it was read from.
 *
 * The exemption is granted only when EVERY source that matched is a file at
 * the very address the call writes to. One foreign source is enough for there
 * to be no exemption: a mixture of one's own text with somebody else's is
 * already a transfer of the other's text, not a return of one's own. A web
 * source is never exempted: it has no file address and nothing to match
 * against — hence the check on the source kind, not on the label alone.
 *
 * The disk is not touched at all: the gate is synchronous, and on the harness
 * a hook that times out does not block the call. So both sides
 * are resolved lexically and symbolic links are NOT followed. The price is
 * known: a link `/tmp/doc.md` pointing at somebody else's file will not get
 * an exemption, because it matches lexically — but writing through it is
 * possible without any Cordon at all, and what was read returns to the same
 * place.
 */
function returnsToOrigin(
  sources: readonly Source[],
  parts: readonly Field[],
  effects: readonly EffectClass[],
): boolean {
  if (sources.length === 0) return false
  if (!effects.some((effect) => PUTS_BACK.has(effect))) return false
  if (effects.some((effect) => BEYOND_PATH.has(effect))) return false
  // A link in the arguments means a second channel: the destination path is
  // then not the only exit, and matching it guarantees nothing.
  if (parts.some(({ key, value }) => URL_KEYS.has(fold(key)) && isFilled(value))) return false

  const target = destination(parts)
  if (target === null) return false

  return sources.every(
    (source) => source.kind === 'file' && isFilled(source.label) && samePath(source.label, target),
  )
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The call's single destination address.
 *
 * There may be no paths in the arguments at all — then there is nowhere to
 * return the content to, and there is no exemption. There may also be several
 * different ones: then it is unclear which is "the" one, and a second address
 * is a second exit, so again no exemption. The path is extracted the same way
 * self-protection extracts it.
 */
function destination(parts: readonly Field[]): string | null {
  const seen = new Set<string>()
  for (const { key, value } of parts) {
    if (!PATH_KEYS.has(fold(key))) continue
    const paths = asPaths(value)
    // null means "not a path", but we only get here after self-protection,
    // which would have refused on such an argument.
    if (paths === null) return null
    for (const path of paths) {
      if (!isFilled(path)) continue
      seen.add(normalizePath(path))
      if (seen.size > 1) return null
    }
  }
  const only = [...seen][0]
  return only ?? null
}

/** Lexical path resolution, without touching the filesystem. */
function normalizePath(path: string): string {
  return resolve(path)
}

/**
 * Case is deliberately not folded. On a case-insensitive filesystem this
 * yields an extra denial of the exemption, that is, an error in the direction
 * of asking, whereas folding would widen the set of exempted calls.
 */
function samePath(label: string, target: string): boolean {
  return normalizePath(label) === target
}

/**
 * Where a refused value came from, in words the model can repeat to the user.
 * Measured twice live: a bare "quarantine is impossible" was retold as "an
 * invalid IBAN" and as "a technical issue", and the user learned nothing.
 */
/**
 * Where the value came from, in the refusal. The label is a link or a path the
 * model chose, often straight off the page, and the refusal is read by the
 * model and, as a question, by the human. So it goes through the footer's
 * defanging: a newline or a markdown link in it would put the page's words in
 * Cordon's voice. The label itself stays whole elsewhere: trust is matched on it.
 */
function origin(blamed: readonly string[]): string {
  return blamed.length === 0 ? '' : `; the value came from ${blamed.map(safeLabel).join(', ')}, not from you`
}

/**
 * A read aimed at a record by an identifier the untrusted source supplied,
 * while the exposure mark stands.
 *
 * AgentDojo's slack suite measured the cost of refusing it: a tool lists
 * channels, the model reads `External_0` from the list, and the read was
 * refused as a tainted target — honest utility fell from 96% to 23%.
 *
 * Why an identifier and nothing wider: what an identifier names is a record
 * the same kind of tool serves, and what comes back is untrusted too, so it
 * is recorded and any later egress of it answers to provenance. A path, a
 * link or an address can name something the user trusts — `~/.ssh/id_rsa` —
 * whose content comes back untainted; after the user's next message lifts
 * the mark, nothing would stop it leaving. Those keep escalating.
 *
 * Why only under a live mark: while it stands, every call that could carry
 * what was read outward escalates anyway. A mark restored from memory is not
 * a live read in this session, and exposure: false removes the backstop the
 * argument rests on. Reviewed with an outside model before it was written.
 */
function identifierReadUnderMark(
  effects: readonly EffectClass[],
  targets: readonly string[],
  ctx: GateContext,
): boolean {
  if (ctx.policy.exposure === false) return false
  if (ctx.exposure === undefined || ctx.exposure === null || ctx.exposure.memory === true) return false
  if (!effects.every((effect) => effect === 'read' || effect === 'summarize')) return false
  return targets.every(isIdentifier)
}

/**
 * The identifier class of the atom extractor, and only it: a token of
 * letters, digits, `_` and `-` with a digit in it. Anything with a slash, a
 * tilde, a scheme or an `@` is a path, a link or an address.
 */
function isIdentifier(atom: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{7,}$/u.test(atom) && /\d/u.test(atom)
}

/**
 * A date does not count as a target. It fits the identifier rule, turns up in
 * every other document and matches by coincidence, while it cannot be used to
 * aim an action. For irreversible effects this distinction does not apply:
 * there any match answers.
 */
function isDate(atom: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(atom) || /^\d{2}[./]\d{2}[./]\d{4}$/u.test(atom)
}

/**
 * Checking the certificate's resource boundaries.
 *
 * An empty list of boundaries constrains nothing: see the comment on
 * ResourceBounds. A non-empty list constrains, and then any argument that
 * looks like a path or a link must fall inside it.
 *
 * Returns the reason for stepping outside a boundary, or null.
 */
function outOfBounds(parts: readonly Field[], cert: Certificate): string | null {
  const paths = usableBounds(cert.resources?.paths)
  const hosts = usableHosts(cert.resources?.hosts)
  const checkPaths = boundsDeclared(cert.resources?.paths)
  const checkHosts = boundsDeclared(cert.resources?.hosts)
  if (!checkPaths && !checkHosts) return null

  for (const { key, value } of parts) {
    if (typeof value !== 'string') continue
    const folded = fold(key)

    if (checkPaths && PATH_KEYS.has(folded) && !insideAnyBound(value, paths)) {
      return `argument ${key} is outside the certificate's boundaries: ${value}`
    }

    if (checkHosts && URL_KEYS.has(folded) && !hostAllowed(value, hosts)) {
      return `the link in argument ${key} is outside the certificate's boundaries: ${value}`
    }
  }

  return null
}

/**
 * Boundaries are declared when the list is non-empty. A list of nothing but
 * empty strings is declared yet names no permitted place, so it forbids
 * everything: an empty string in YAML is a typo, not "allow anything".
 */
function boundsDeclared(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function usableBounds(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  const out: string[][] = []
  for (const bound of value) {
    if (typeof bound !== 'string' || bound.trim() === '') continue
    for (const form of canonicalForms(bound)) out.push(segments(form))
  }
  return out
}

/** A path as a list of segments. A trailing separator makes no difference. */
function segments(path: string): string[] {
  return path.split(sep).filter((part) => part !== '')
}

/**
 * A path is inside a boundary when EVERY one of its forms sits inside one of
 * the declared boundaries. Requiring it of all forms at once closes the case
 * of a symbolic link that lies inside a boundary and leads outside:
 * lexically such a path is inside, on disk it is outside.
 *
 * Case is not folded, unlike in self-protection. Folding would widen the set
 * of paths considered permitted, and here the error must run in the direction
 * of an extra question.
 */
function insideAnyBound(target: string, bounds: readonly string[][]): boolean {
  if (bounds.length === 0) return false
  for (const form of canonicalForms(target)) {
    const parts = segments(form)
    // Comparison is segment by segment rather than by string prefix:
    // otherwise the boundary "/srv/project" would cover the neighbouring
    // "/srv/project-secrets".
    const covered = bounds.some(
      (bound) => bound.length <= parts.length && bound.every((part, at) => part === parts[at]),
    )
    if (!covered) return false
  }
  return true
}

/**
 * Boundary host names, normalized to the form URL parsing produces: lower
 * case, punycode for non-ASCII, no trailing dot.
 */
function usableHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const bound of value) {
    if (typeof bound !== 'string') continue
    const host = normalizeHost(bound)
    if (host) out.push(host)
  }
  return out
}

function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try {
    const host = new URL(`http://${trimmed}`).hostname
    return host === '' ? null : stripTrailingDot(host)
  } catch {
    // A value that does not parse even as a bare host name cannot be a
    // boundary. Silently treating it as "any host" is not an option.
    return null
  }
}

function stripTrailingDot(host: string): string {
  return host.replace(/\.+$/u, '').toLowerCase()
}

/**
 * A link's host is inside a boundary.
 *
 * The host name is compared in full and only from the host position of the
 * parsed link: a substring match would grant trust to a link like
 * https://evil.example/docs.internal/x. A subdomain of a declared host is not
 * covered by the boundary: allowing subdomains must be explicit, otherwise
 * one domain opens up everything anyone manages to register under it. A link
 * that failed to parse is not covered: unparsed means refusal, not a pass.
 */
function hostAllowed(raw: string, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return false
  let host: string
  try {
    host = stripTrailingDot(new URL(raw).hostname)
  } catch {
    return false
  }
  if (host === '') return false
  return hosts.includes(host)
}
