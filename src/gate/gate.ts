import { resolve, sep } from 'node:path'
import type { Certificate, Decision, EffectClass, Source, ToolCall } from '../core/types.js'
import type { Policy } from '../policy/defaults.js'
import { canonicalForms, touchesCordonItself } from '../policy/selfprotect.js'
import type { TaintStore } from '../provenance/store.js'
import { covers } from '../scope/certificate.js'
import { classify } from '../scope/effects.js'
import { quarantine } from './quarantine.js'

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
}

/**
 * Arguments whose value is a filesystem path.
 *
 * Names are folded to one form: `file_path`, `filePath` and `FILE-PATH` are
 * chosen by the MCP server and all mean the same thing.
 */
const PATH_KEYS: ReadonlySet<string> = new Set([
  'filepath', 'filepaths', 'path', 'paths', 'notebookpath',
  'targetpath', 'destination', 'dest', 'outputpath',
])

/** Arguments whose value is executed by a shell. */
const COMMAND_KEYS: ReadonlySet<string> = new Set(['command', 'cmd', 'script', 'shell'])

/**
 * Arguments whose value is a link. As with paths, the names are folded to one
 * form: the MCP server chooses them.
 */
const URL_KEYS: ReadonlySet<string> = new Set([
  'url', 'urls', 'uri', 'uris', 'href', 'link', 'links',
  'endpoint', 'webhook', 'baseurl', 'callbackurl',
])

/** Limits on walking the arguments. Exceeding them is a refusal, not a truncated walk. */
const MAX_FIELDS = 2000
const MAX_DEPTH = 8

export function gate(call: ToolCall, ctx: GateContext): Decision {
  try {
    return decide(call, ctx)
  } catch (error) {
    // A core error is a deny. The only exception handler in the
    // whole module, and everything leads here.
    return { kind: 'deny', reason: `Cordon failure: ${(error as Error).message}` }
  }
}

function decide(call: ToolCall, ctx: GateContext): Decision {
  if (typeof call?.tool !== 'string' || call.tool === '') {
    return { kind: 'deny', reason: 'a call without a tool name' }
  }
  const args: unknown = call.args
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { kind: 'deny', reason: `the arguments of call ${call.tool} did not arrive as an object` }
  }
  const own = args as Record<string, unknown>
  const parts = fields(own)

  const selfHit = selfProtection(parts, ctx)
  if (selfHit) return selfHit

  const verdict = classify(call, ctx.policy.tools)

  // The hidden layer was not fully stripped, which means the model read
  // poisoned text. Reading further is not dangerous; acting on what was read
  // is dangerous exactly to the extent that we do not know what it read.
  if (ctx.unredacted === true) {
    const harmless = verdict.classified
      && verdict.effects.every((effect) => effect === 'read' || effect === 'summarize')
    if (!harmless) return escalate(ctx, 'a hidden layer in a tool result could not be stripped')
  }

  if (!verdict.classified) {
    return escalate(ctx, verdict.reason)
  }

  const coverage = covers(ctx.cert, verdict.effects, ctx.turn)
  if (!coverage.ok) {
    return escalate(ctx, coverage.reason)
  }

  // Resource boundaries come after effect classes and before the taint
  // check: a call outside a declared boundary is refused regardless of how
  // clean its arguments are. Taint is irrelevant here; the right is missing
  // by location alone.
  const outside = outOfBounds(parts, ctx.cert)
  if (outside) {
    return escalate(ctx, outside)
  }

  const scan = scanTaint(parts, ctx.taint)
  if (!scan.tainted) return { kind: 'allow' }

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
    if (targets.length === 0) return { kind: 'allow' }
    return escalate(ctx, `an argument carries a target from an untrusted source: ${targets.join(', ')}`)
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
    return escalate(ctx, 'quarantine is impossible: the untrusted fragment sits inside a nested argument')
  }

  const cleaned = quarantine(own, scan.spans)
  if (!cleaned.possible) {
    return escalate(ctx, `quarantine is impossible: ${cleaned.reason}`)
  }

  return {
    kind: 'rewrite',
    args: cleaned.args,
    removed: cleaned.removed,
    reason: 'an untrusted fragment was cut out of the arguments',
  }
}

interface Field {
  /** Name of the nearest object field. An array element inherits its field's name. */
  key: string
  value: unknown
  depth: number
}

/**
 * Flattens the arguments into a list of fields.
 *
 * Without descending, a tainted string inside `{payload: {note: "…"}}` is
 * invisible to both axes: provenance only looks at strings, and the string
 * sits one level down. MCP tools accept nested objects all the time, so this
 * is not exotic but an ordinary call.
 */
function fields(args: Record<string, unknown>): Field[] {
  const out: Field[] = []

  const visit = (key: string, node: unknown, depth: number): void => {
    if (out.length >= MAX_FIELDS) throw new Error('the call arguments branch too widely')
    if (depth > MAX_DEPTH) throw new Error('the call arguments are too deep')
    out.push({ key, value: node, depth })
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(key, item, depth + 1)
      return
    }
    for (const [name, value] of Object.entries(node)) visit(name, value, depth + 1)
  }

  for (const [key, value] of Object.entries(args)) visit(key, value, 0)
  return out
}

/** The argument name is chosen by the MCP server, so it is compared folded. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
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
        return { kind: 'deny', reason: `self-protection: argument ${key} is not a path` }
      }
      for (const path of paths) {
        if (touchesCordonItself(path, ctx.cordonHome)) {
          return { kind: 'deny', reason: `self-protection: ${path} belongs to Cordon or to the harness` }
        }
      }
    }

    // A shell can do everything a file tool can, only bypassing the path
    // argument: `echo "mode: off" > ~/.cordon/policy.yaml`. Parsing the shell
    // command here is not an option, every shell parser can be worked around.
    // So the check is crude, by substring, and declared incomplete: assembly
    // from variables gets around it. It closes the direct case; full closure
    // comes only from the absence of `exec` in the certificate.
    if (COMMAND_KEYS.has(folded) && typeof value === 'string') {
      for (const marker of selfMarkers(ctx.cordonHome)) {
        if (value.includes(marker)) {
          return { kind: 'deny', reason: `self-protection: the command mentions ${marker}` }
        }
      }
    }
  }

  return null
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
function selfMarkers(cordonHome: string): string[] {
  return [cordonHome, '.cordon', '.claude/settings', '.claude/hooks', '.cursor', '.codex', '.gemini']
}

function escalate(ctx: GateContext, reason: string): Decision {
  return ctx.policy.mode === 'interactive' ? { kind: 'ask', reason } : { kind: 'deny', reason }
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

function scanTaint(parts: readonly Field[], taint: TaintStore): Scan {
  const spans: Record<string, Array<[number, number]>> = {}
  const targets = new Set<string>()
  const sources = new Map<string, Source>()
  let tainted = false
  let nested = false

  for (const { key, value, depth } of parts) {
    if (typeof value !== 'string') continue
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
const BEYOND_PATH: ReadonlySet<EffectClass> = new Set(['network-egress', 'financial', 'exec'])

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
