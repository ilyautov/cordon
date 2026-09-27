import { createHash } from 'node:crypto'
import { canonical } from '../core/canonical.js'
import type { Policy } from './defaults.js'

/**
 * The identity of a policy as the gate applies it: the effective policy,
 * defaults merged in, with sorted keys. Two files that differ only in
 * comments or key order are the same policy; a default that changed between
 * versions is a different one.
 */
export function policyHash(policy: Policy): string {
  return createHash('sha256').update(canonical(policy), 'utf8').digest('hex')
}
