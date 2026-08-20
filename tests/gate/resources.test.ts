import { describe, expect, it } from 'vitest'
import { gate } from '../../src/gate/gate.js'
import { TaintStore } from '../../src/provenance/store.js'
import { issue } from '../../src/scope/certificate.js'
import { DEFAULT_POLICY, type Policy } from '../../src/policy/defaults.js'

function ctxWith(paths: string[], hosts: string[]) {
  const policy: Policy = structuredClone(DEFAULT_POLICY)
  policy.mode = 'interactive'
  policy.profile = { effects: ['read', 'create', 'network-egress'], resources: { paths, hosts } }
  policy.tools = { fetch_page: ['read', 'network-egress'] }
  return {
    policy,
    cert: issue(policy, 0),
    taint: new TaintStore(),
    cordonHome: '/home/u/.cordon',
    turn: 1,
  }
}

describe('resource bounds', () => {
  it('empty lists bound nothing', () => {
    const ctx = ctxWith([], [])
    expect(gate({ tool: 'Read', args: { file_path: '/any/path.txt' } }, ctx).kind).toBe('allow')
    expect(gate({ tool: 'fetch_page', args: { url: 'https://example.com/a' } }, ctx).kind).toBe('allow')
  })

  it('a path inside a declared boundary passes', () => {
    const ctx = ctxWith(['/srv/project/'], [])
    expect(gate({ tool: 'Read', args: { file_path: '/srv/project/src/a.ts' } }, ctx).kind).toBe('allow')
  })

  it('a path outside the boundary escalates', () => {
    const ctx = ctxWith(['/srv/project/'], [])
    const decision = gate({ tool: 'Read', args: { file_path: '/home/u/.ssh/id_rsa' } }, ctx)
    expect(decision.kind).toBe('ask')
    expect(decision.kind === 'ask' && decision.reason).toContain('boundaries')
  })

  it('directory climbing does not lead outside the boundary unnoticed', () => {
    const ctx = ctxWith(['/srv/project/'], [])
    expect(gate({ tool: 'Read', args: { file_path: '/srv/project/../../etc/passwd' } }, ctx).kind).toBe('ask')
  })

  it('a neighbouring directory sharing a prefix does not count as inside', () => {
    const ctx = ctxWith(['/srv/project/'], [])
    expect(gate({ tool: 'Read', args: { file_path: '/srv/project-secrets/k.pem' } }, ctx).kind).toBe('ask')
  })

  it('a host from the declared list passes', () => {
    const ctx = ctxWith([], ['docs.internal'])
    expect(gate({ tool: 'fetch_page', args: { url: 'https://docs.internal/api' } }, ctx).kind).toBe('allow')
  })

  it('a foreign host escalates', () => {
    const ctx = ctxWith([], ['docs.internal'])
    expect(gate({ tool: 'fetch_page', args: { url: 'https://evil.example/collect' } }, ctx).kind).toBe('ask')
  })

  it('a subdomain of a declared host is not covered by the boundary', () => {
    const ctx = ctxWith([], ['docs.internal'])
    expect(gate({ tool: 'fetch_page', args: { url: 'https://a.docs.internal/x' } }, ctx).kind).toBe('ask')
  })

  it("a host in the path of a foreign link grants no trust", () => {
    const ctx = ctxWith([], ['docs.internal'])
    expect(gate({ tool: 'fetch_page', args: { url: 'https://evil.example/docs.internal/x' } }, ctx).kind).toBe('ask')
  })

  it('the boundaries are checked after self-protection, not instead of it', () => {
    const ctx = ctxWith(['/home/u/'], [])
    const decision = gate({ tool: 'Write', args: { file_path: '/home/u/.cordon/policy.yaml' } }, ctx)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('self-protection')
  })

  // Below are our own checks, absent from the plan.

  it('an empty string in the boundary list does not open everything', () => {
    const ctx = ctxWith([''], [])
    expect(gate({ tool: 'Read', args: { file_path: '/etc/passwd' } }, ctx).kind).toBe('ask')
  })

  it('an empty string in the host list does not open everything', () => {
    const ctx = ctxWith([], [''])
    expect(gate({ tool: 'fetch_page', args: { url: 'https://evil.example/x' } }, ctx).kind).toBe('ask')
  })

  it('an unparsed link is not covered by the boundary', () => {
    const ctx = ctxWith([], ['docs.internal'])
    expect(gate({ tool: 'fetch_page', args: { url: '/api/relative' } }, ctx).kind).toBe('ask')
  })

  it("a path boundary does not cover the boundary itself as a neighbour's file", () => {
    const ctx = ctxWith(['/srv/project'], [])
    expect(gate({ tool: 'Read', args: { file_path: '/srv/projectile' } }, ctx).kind).toBe('ask')
  })

  it('a path in a nested argument is checked too', () => {
    const ctx = ctxWith(['/srv/project/'], [])
    const call = { tool: 'Read', args: { payload: { path: '/home/u/.ssh/id_rsa' } } }
    expect(gate(call, ctx).kind).toBe('ask')
  })

  it('a link in a nested argument is checked too', () => {
    const ctx = ctxWith([], ['docs.internal'])
    const call = { tool: 'fetch_page', args: { payload: { url: 'https://evil.example/x' } } }
    expect(gate(call, ctx).kind).toBe('ask')
  })

  it('a difference of case in a directory name does not count as a match', () => {
    // On Linux these are different directories. An extra question is cheaper
    // than a miss.
    const ctx = ctxWith(['/srv/project/'], [])
    expect(gate({ tool: 'Read', args: { file_path: '/srv/Project/a.ts' } }, ctx).kind).toBe('ask')
  })

  it('a host with a leading dot in the boundary does not open subdomains', () => {
    const ctx = ctxWith([], ['.docs.internal'])
    expect(gate({ tool: 'fetch_page', args: { url: 'https://a.docs.internal/x' } }, ctx).kind).toBe('ask')
  })

  it('in autonomous mode stepping outside a boundary is a refusal', () => {
    const ctx = ctxWith(['/srv/project/'], [])
    ctx.policy.mode = 'autonomous'
    expect(gate({ tool: 'Read', args: { file_path: '/etc/passwd' } }, ctx).kind).toBe('deny')
  })
})
