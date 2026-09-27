/**
 * The rule behind a decision, and what a refused call would have done.
 *
 * A closed list, so a journal reader and a SIEM filter on a code that stays
 * the same across rewordings of the reason. The class and tier are a label
 * on the decision and never an input to one: nothing here is consulted by
 * the gate.
 *
 * The tier says what the rule answers to, and so how much its firing says
 * about an attacker:
 * - evidence: something from outside was found in the call or the tool
 *   list, a matched fragment or a changed tool;
 * - suspicion: the rule fires only because the session read untrusted
 *   content, and nothing read was found in the call. An honest task after
 *   reading a page lands here too. Content that could not be scanned (an
 *   image, a result of unfamiliar shape) is here and not under evidence:
 *   nothing was found in it, it was not looked into (Codex);
 * - precaution: the rule fires the same whether or not anything untrusted
 *   was read. The call is outside what the policy grants, reaches Cordon's
 *   own files, or carries a key. It does not say no untrusted content was
 *   involved, only that the decision did not turn on it; and a SIEM that
 *   counts it as an attack teaches its readers to ignore the stream (Kimi).
 */
export const RULES = {
  malformed: { class: 'guard-failure', tier: 'precaution' },
  failure: { class: 'guard-failure', tier: 'precaution' },
  pin: { class: 'tool-rug-pull', tier: 'evidence' },
  'self-protection': { class: 'guard-tampering', tier: 'precaution' },
  'agent-config': { class: 'guard-tampering', tier: 'suspicion' },
  unscanned: { class: 'unscanned-content', tier: 'suspicion' },
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
  budget: { class: 'flooding', tier: 'precaution' },
} as const satisfies Record<string, { class: string; tier: Tier }>

export type Tier = 'evidence' | 'suspicion' | 'precaution'
export type Rule = keyof typeof RULES
export type AttackClass = (typeof RULES)[Rule]['class']
