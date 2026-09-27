/**
 * The rule behind a decision, and what a refused call would have done.
 *
 * A closed list, so a journal reader and a SIEM filter on a code that stays
 * the same across rewordings of the reason. The class and tier are a label
 * on the decision and never an input to one: nothing here is consulted by
 * the gate.
 *
 * The tier says how much the decision knows about an attacker:
 * - evidence: something from outside was seen in the call or the tool list,
 *   a matched fragment, a hidden layer, a changed tool;
 * - suspicion: the session read untrusted content and the call is not
 *   vouched for, but nothing read was found in it. An honest task after
 *   reading a page lands here too;
 * - precaution: no untrusted content is involved at all. The call is outside
 *   what the policy grants, or carries a key. Not an attack, and a SIEM that
 *   counts it as one teaches its readers to ignore the stream (Kimi).
 */
export const RULES = {
  malformed: { class: 'guard-failure', tier: 'precaution' },
  failure: { class: 'guard-failure', tier: 'precaution' },
  pin: { class: 'tool-rug-pull', tier: 'evidence' },
  'self-protection': { class: 'guard-tampering', tier: 'suspicion' },
  'agent-config': { class: 'guard-tampering', tier: 'suspicion' },
  'hidden-layer': { class: 'hidden-instruction', tier: 'evidence' },
  saturation: { class: 'flooding', tier: 'suspicion' },
  unclassified: { class: 'out-of-scope', tier: 'precaution' },
  certificate: { class: 'out-of-scope', tier: 'precaution' },
  bounds: { class: 'out-of-scope', tier: 'precaution' },
  credential: { class: 'credential-egress', tier: 'precaution' },
  resource: { class: 'resource-hop', tier: 'suspicion' },
  controlled: { class: 'parameter-tampering', tier: 'suspicion' },
  exposure: { class: 'unvouched-destination', tier: 'suspicion' },
  'memory-carry': { class: 'memory-poisoning', tier: 'suspicion' },
  'memory-write': { class: 'memory-poisoning', tier: 'evidence' },
  provenance: { class: 'untrusted-payload', tier: 'evidence' },
} as const satisfies Record<string, { class: string; tier: Tier }>

export type Tier = 'evidence' | 'suspicion' | 'precaution'
export type Rule = keyof typeof RULES
export type AttackClass = (typeof RULES)[Rule]['class']
