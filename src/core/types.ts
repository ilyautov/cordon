/** Effect classes. Scope is expressed in them, not in tool names. */
export type EffectClass =
  | 'read'
  | 'summarize'
  | 'create'
  | 'update'
  | 'delete'
  | 'export'
  | 'network-egress'
  | 'financial'
  | 'exec'

/** Presence mode. An explicit setting, not a heuristic: see §6 of the spec. */
export type PresenceMode = 'interactive' | 'autonomous'

export interface ToolCall {
  /** The tool name in the harness's terms. */
  tool: string
  args: Record<string, unknown>
}

/**
 * Resource bounds inside a certificate.
 *
 * An empty list means "no bound on this resource", not "nothing". The
 * opposite reading would make the default policy unusable: both lists are
 * empty there, and the agent could not read a single file. Bounding by
 * resource is secondary to bounding by effect class.
 */
export interface ResourceBounds {
  /** Path prefixes allowed for file effects. Empty means "any". */
  paths: string[]
  /** Host names allowed for network-egress. Empty means "any". */
  hosts: string[]
}

export interface Certificate {
  effects: EffectClass[]
  resources: ResourceBounds
  issuedAtTurn: number
  /** null means "until the end of the session". */
  expiresAtTurn: number | null
  /** profile — straight from the policy; narrowed — narrowed by a user directive. */
  origin: 'profile' | 'narrowed'
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'rewrite'; args: Record<string, unknown>; removed: string[]; reason: string }

export type TrustLabel = 'trusted' | 'untrusted'

/**
 * What a tool returns: the source or the rendered form.
 *
 * Exactly two values, because exactly one question is being decided: does the
 * human see this text the same way the model receives it. `source` means
 * "sees it the same", that is, there is no layer hidden from them here and
 * nothing to cut; `rendered` means "sees it differently", that is, the layer
 * exists.
 */
export type SourceView = 'rendered' | 'source'

export interface Source {
  /** A stable identifier within the session. */
  id: string
  kind: 'user' | 'system' | 'web' | 'tool' | 'mcp-description' | 'file' | 'bash'
  /** A URL, a path or a tool name. Shown to the user. */
  label: string
  trust: TrustLabel
  /**
   * The source view declared by the human in the policy (`toolsReturn`).
   *
   * An absent field means exactly "there was no declaration", not "somebody
   * forgot to fill it in": the only place a source is assembled for work is
   * `classifySource`, and it always fills the field when a declaration
   * exists. Optionality here carries meaning rather than convenience: it
   * shows where a default is in force and where a human's decision is.
   */
  declaredView?: SourceView
}

/**
 * Whether the human sees this source rendered rather than as source text.
 *
 * The foundation of all neutralization lies here, which is why it is written
 * as a single function serving both adapters. Cordon removes what is hidden
 * **from the human**, and hiddenness is determined by the way the human looks
 * at THIS source. They see a web page rendered: a comment, a `<style>` block
 * and a `display:none` block never reach their eyes, so removing them is
 * honest. They open a file in an editor and see all of it as source text, so
 * there is no hidden layer there at all, and removal would take content away
 * from them.
 *
 * The cost of an error here is asymmetric, and that is the second argument. A
 * substituted read result goes back to the model and then on into `Write`,
 * that is, it destroys the user's file silently and irreversibly. A hidden
 * layer missed in a local file requires the attacker to put that file there
 * first, and then runs into the two remaining axes: the certificate bounds
 * actions, provenance remembers what was read.
 *
 * `bash` lands here on the same grounds: the human sees a command's output in
 * the terminal as exactly the text the model receives.
 *
 * The human's declaration in the policy (`toolsReturn`) is stronger than any
 * default and works in both directions. Otherwise the source view would be
 * derived from the tool name, and an MCP tool's name is chosen by the server,
 * that is, by the untrusted side: §9.2 explains why it cannot be believed. A
 * server that named its tool `read_file` does not get the built-in reader's
 * behaviour for free — but a human who knows what that server is may say so
 * out loud, and their word is final here.
 *
 * ## The default for an MCP tool: source
 *
 * The choice is deliberate, and both options are bad. Treating it as rendered
 * means stripping the hidden layer from the result of any MCP server — but a
 * server that reads files (`mcp__filesystem__read_file` and any like it)
 * hands the model a file without its `<style>`, `<script>` and comments, and
 * writing such a file back destroys its content. Treating it as source means
 * missing the hidden layer of a page that arrived through an MCP server.
 *
 * The second was chosen, on three arguments at once — the same ones that put
 * `file` here. First: file destruction happens ALWAYS and without any
 * attacker — an ordinary read of ordinary markup is enough — while a miss
 * requires somebody to plant the injection and requires the model to fall for
 * it. Second: destruction is silent and irreversible, a miss is loud — the
 * finding is named to the human through `systemMessage` and goes into the log
 * marked `notice`. Third: a miss runs into the two remaining axes (the
 * certificate bounds effect classes, provenance remembers what was read by
 * its source text), while file destruction runs into nothing: writing back
 * what was read is a legitimate `update`, and no axis will stop it.
 *
 * The price is named: the marketplace-reviews scenario now takes one line of
 * policy (`toolsReturn: {tool: rendered}`) for the hidden layer to be
 * stripped as before. The default is announced out loud in `cordon doctor`
 * and in §8 of the spec, because a human should not have to learn it from the
 * source code.
 *
 * `mcp-description` stays rendered, and that is not an inconsistency. The
 * human does not see a tool description at all — it is hidden from them
 * entirely — and it is never written back to disk, so neither argument for
 * `source` applies there at either end.
 */
export function humanSeesRendered(source: Pick<Source, 'kind' | 'declaredView'>): boolean {
  if (source.declaredView !== undefined) return source.declaredView === 'rendered'
  return RENDERED_BY_DEFAULT.has(source.kind)
}

/**
 * The source kinds a human sees rendered by default.
 *
 * These are enumerated rather than the exceptions: a list of exceptions grows
 * silently, because a new source kind joins it by default. Here a new kind is
 * treated as source by default, that is, it is not substituted, and the error
 * runs in the direction of preserving data.
 */
const RENDERED_BY_DEFAULT: ReadonlySet<Source['kind']> = new Set<Source['kind']>([
  'user', 'system', 'web', 'mcp-description',
])

/**
 * Whether we know the source view or substituted a default.
 *
 * Needed for the conversation with the human, not for the decision. About a
 * file that was read we know: the human sees it as source, and there is
 * nothing to cut out of it. About an MCP tool's result we know nothing — the
 * default fired — and explaining the pass by care for a file where there may
 * be no file at all means passing a guess off as knowledge. A human who reads
 * such an explanation will conclude that Cordon worked it out, and Cordon did
 * not work it out and cannot.
 */
export function viewIsUnknown(source: Pick<Source, 'kind' | 'declaredView'>): boolean {
  return source.declaredView === undefined && !RENDERED_BY_DEFAULT.has(source.kind) &&
    source.kind !== 'file' && source.kind !== 'bash'
}

/** Checks containment of effect-class sets. */
export function isSubsetOf(part: readonly EffectClass[], whole: readonly EffectClass[]): boolean {
  const set = new Set(whole)
  return part.every((effect) => set.has(effect))
}
