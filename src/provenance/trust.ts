import type { Source, SourceView } from '../core/types.js'
import type { Policy } from '../policy/defaults.js'
import { hash } from './normalize.js'

/** Where the text came from. No trust label here deliberately: the core computes it. */
export interface Origin {
  kind: Source['kind']
  label: string
  /**
   * The tool name under which it is declared in the policy.
   *
   * Kept apart from `label`: a source's label is a link or a path taken from
   * the call's arguments, and it need not coincide with the tool name.
   * Looking a declaration up by the label would mean never finding it.
   *
   * The name comes from the harness, and for an MCP call the server chooses
   * it. It authorizes nothing here: it serves as the key to what the human
   * said about it, and nothing else.
   */
  tool?: string
}

/**
 * Computes the trust label. The single place where this decision is made: the
 * adapter reports where the text came from but does not decide whether to
 * trust it.
 *
 * Trusted means exactly two things: the user's message and the system prompt.
 * Everything else is untrusted until the user says otherwise explicitly. An
 * MCP tool description is written by the server, not by the user, so it is
 * untrusted on a par with call results.
 */
export function classifySource(origin: Origin, policy: Policy): Source {
  const declared = declaredView(origin.tool, policy)
  return {
    // The identifier is computed from the kind and the label and does NOT
    // depend on the declaration: otherwise one and the same source would look
    // like two different ones before and after a policy edit, and the
    // previous turn's provenance would not be found.
    id: hash(`${origin.kind}|${origin.label}`),
    kind: origin.kind,
    label: origin.label,
    trust: isTrusted(origin, policy) ? 'trusted' : 'untrusted',
    ...(declared === undefined ? {} : { declaredView: declared }),
  }
}

/**
 * What the human declared about this tool in the policy.
 *
 * The tool name comes from outside and the object is not indexed by it
 * directly: only `Object.hasOwn`, and only with a type check on the value.
 * The project has been burned by this already — `fromPolicy['toString']` once
 * produced a full-blown classification with effects assembled out of the
 * letters of the word — and this is the same case: an MCP tool's name is
 * chosen by the server.
 *
 * The value is validated even though the policy loader validated it earlier.
 * Relying on having been called through the loader is not allowed: `Policy`
 * is also assembled by tests and by calling code, and garbage in the value
 * must mean the absence of a declaration rather than a declaration of
 * garbage.
 */
function declaredView(tool: string | undefined, policy: Policy): SourceView | undefined {
  if (typeof tool !== 'string' || tool === '') return undefined

  const table: unknown = policy.toolsReturn
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return undefined
  if (!Object.hasOwn(table, tool)) return undefined

  const declared: unknown = (table as Record<string, unknown>)[tool]
  return declared === 'rendered' || declared === 'source' ? declared : undefined
}

function isTrusted(origin: Origin, policy: Policy): boolean {
  if (origin.kind === 'user' || origin.kind === 'system') return true

  const label = origin.label
  if (typeof label !== 'string' || label === '') return false
  // Directory climbing inside the label. The prefix will match, yet the label
  // leads outside the trusted root: "/srv/docs/../../root/.ssh/id_rsa" starts
  // with "/srv/docs/" and has nothing to do with it.
  if (climbs(label)) return false

  // The list comes from YAML and may have been assembled by hand. Not a list
  // means no declarations, not an exception in the middle of the hot path.
  const declared = Array.isArray(policy.trustedSources) ? policy.trustedSources : []

  return declared.some((prefix) => {
    // An empty string, once the separator is appended, turns into "/", that
    // is, into trust for any absolute path. In YAML it appears by itself:
    // leaving a list item without a value is enough.
    if (typeof prefix !== 'string' || prefix.trim() === '') return false
    if (label === prefix) return true

    // Prefix comparison with a mandatory separator.
    //
    // A bare startsWith would trust the domain "docs.internal.evil.example"
    // against a declared "https://docs.internal", that is, exactly the
    // substitution we defend against. Relying on the user not forgetting the
    // slash is not allowed: the price of forgetfulness here is an open hole,
    // so the separator is appended for them.
    const withSeparator = prefix.endsWith('/') ? prefix : `${prefix}/`
    return label.startsWith(withSeparator)
  })
}

/** Two dots as a whole segment is a climb. Two dots inside a name are not. */
function climbs(label: string): boolean {
  const plain = label.replace(/%2e/giu, '.')
  return plain.split(/[/\\]/u).includes('..')
}
