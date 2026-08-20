import type { Certificate, EffectClass } from '../core/types.js'
import type { Policy } from '../policy/defaults.js'

const KNOWN: ReadonlySet<string> = new Set<EffectClass>([
  'read', 'summarize', 'create', 'update', 'delete',
  'export', 'network-egress', 'financial', 'exec',
])

/**
 * Picks only the known effect classes out of anything at all.
 *
 * The policy comes from YAML, and YAML is written by hand: `effects: read`
 * instead of a list is one forgotten dash. A string spread out letter by
 * letter would pass itself off as a set of classes, so the shape is checked
 * and the unknown is discarded. Discarding narrows, that is, it errs in the
 * right direction.
 */
function knownEffects(value: unknown): EffectClass[] {
  if (!Array.isArray(value)) return []
  const result: EffectClass[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !KNOWN.has(item)) continue
    const effect = item as EffectClass
    if (!result.includes(effect)) result.push(effect)
  }
  return result
}

/** A list of strings from a structure untrusted in shape. Not a list means "empty". */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Issues a certificate from the policy profile.
 *
 * Not a line of untrusted content reaches here, and none can: the input is
 * configuration only. This is the very rule of §4.3 that leaves Task Shield
 * vulnerable to an adaptive attack and Cordon not.
 *
 * The lists are copied rather than reused: a certificate referencing the
 * policy's array would change along with a re-read policy, and narrowing
 * would stop being monotone.
 */
export function issue(policy: Policy, turn: number): Certificate {
  const profile: unknown = policy?.profile
  const bounds = (profile as { resources?: unknown })?.resources
  return {
    effects: knownEffects((profile as { effects?: unknown })?.effects),
    resources: {
      paths: strings((bounds as { paths?: unknown })?.paths),
      hosts: strings((bounds as { hosts?: unknown })?.hosts),
    },
    issuedAtTurn: turn,
    expiresAtTurn: null,
    origin: 'profile',
  }
}

/**
 * Narrows a certificate to its intersection with the requested set.
 *
 * Widening is impossible not by convention but by construction: the result is
 * an intersection, and a class absent from the original certificate will not
 * appear in it whatever arrives as the second argument. That is why a
 * directive slipped in from untrusted text can only take rights away.
 */
export function narrow(cert: Certificate, requested: readonly EffectClass[]): Certificate {
  const allowed = new Set(knownEffects(cert.effects))
  const kept: EffectClass[] = []
  for (const effect of requested) {
    if (!allowed.has(effect) || kept.includes(effect)) continue
    kept.push(effect)
  }
  return { ...cert, effects: kept, origin: 'narrowed' }
}

export interface Coverage {
  ok: boolean
  missing: EffectClass[]
  reason: string
}

export function covers(cert: Certificate, effects: readonly EffectClass[], turn: number): Coverage {
  if (cert.expiresAtTurn !== null && turn >= cert.expiresAtTurn) {
    return { ok: false, missing: [...effects], reason: 'the certificate has expired' }
  }
  // A call for which not a single effect class could be determined is covered
  // by nothing. Otherwise an unknown MCP tool would pass more freely than a
  // known one, and fail-closed would turn into fail-open.
  if (effects.length === 0) {
    return { ok: false, missing: [], reason: 'the effect class is undetermined' }
  }

  // The certificate may have arrived from a restored session, that is, from
  // disk. A broken shape is an empty set of rights, not the right to
  // everything.
  const allowed = new Set(knownEffects(cert.effects))
  const missing = effects.filter((effect) => !allowed.has(effect))
  if (missing.length === 0) return { ok: true, missing: [], reason: '' }
  return { ok: false, missing, reason: `outside the certificate: ${missing.join(', ')}` }
}

/**
 * Parses an explicit narrowing directive out of a trusted user message.
 *
 * Called ONLY on the user's text. Untrusted text must not be fed here: a
 * directive inside a review is precisely the attack.
 *
 * The first directive is taken. A second one appended below returns no
 * rights: narrowing goes through narrow, and narrow intersects.
 *
 * A directive left with no recognizable class yields an empty list, not null.
 * An empty list means "nothing is allowed": a typo in a class name must be
 * noticeable at once rather than widening rights in silence.
 */
export function parseDirective(userText: string): EffectClass[] | null {
  const match = /^[ \t]*cordon:[ \t]*scope[ \t]+(.+)$/mu.exec(userText)
  if (!match?.[1]) return null
  return knownEffects(match[1].split(/[,\s]+/u).map((token) => token.trim().toLowerCase()))
}
