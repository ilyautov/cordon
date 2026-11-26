export type OutboundCredentialMode = 'review' | 'deny'

/** Shared by YAML loading and the gate, since SDK callers can supply a policy directly. */
export function outboundCredentialMode(policy: { credentials?: unknown }, path = 'policy'): OutboundCredentialMode {
  if (!Object.hasOwn(policy, 'credentials')) return 'review'

  const section = policy.credentials
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${path}: credentials must be an object with an outbound mode`)
  }
  const keys = Reflect.ownKeys(section)
  if (keys.length !== 1 || keys[0] !== 'outbound') {
    throw new Error(`${path}: credentials must contain only credentials.outbound`)
  }
  const mode = (section as Record<string, unknown>).outbound
  if (mode !== 'review' && mode !== 'deny') throw new Error(`${path}: credentials.outbound must be review or deny`)
  return mode
}
