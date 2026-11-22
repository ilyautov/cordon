import { describe, expect, it, vi } from 'vitest'
import { assessMerge, executeMerge } from '../../src/pr-workflow/merge.js'

const target = { repo: 'owner/project', number: 12, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40) }
const receipt = { kind: 'review-completed' as const, ...target,
  runId: '599845b6-4408-4eae-9b35-036d78362b44', diffSha256: '1'.repeat(64), mergeProposed: true }
const ci = { workflowId: 123, workflowSha: 'c'.repeat(40), runId: 42, runAttempt: 1, artifactId: 34,
  artifactDigest: 'sha256:' + 'e'.repeat(64) }
const approval = { ...target, runId: receipt.runId, diffSha256: receipt.diffSha256, ci,
  generation: '688845b6-4408-4eae-9b35-036d78362b44', approvedAt: 1000 }
const facts = { receipt, current: target, diffSha256: receipt.diffSha256, ci, approval }

describe('owner gate for an exact reviewed candidate', () => {
  it('accepts exact review, authenticated CI and owner approval', () => {
    expect(assessMerge(facts)).toEqual({ allow: true, reason: 'approved' })
  })

  it.each([
    { ...target, baseRef: 'release' },
    { ...target, baseSha: 'd'.repeat(40) },
    { ...target, headSha: 'd'.repeat(40) },
  ])('rejects snapshot drift with $baseRef', (current) => {
    expect(assessMerge({ ...facts, current }).reason).toBe('snapshot-changed')
  })

  it('rejects a different diff and a review without a proposal', () => {
    expect(assessMerge({ ...facts, diffSha256: '2'.repeat(64) }).reason).toBe('diff-changed')
    expect(assessMerge({ ...facts, receipt: { ...receipt, mergeProposed: false } }).reason).toBe('not-proposed')
  })

  it('requires authenticated CI and approval for that exact artifact attempt', () => {
    expect(assessMerge({ ...facts, ci: null }).reason).toBe('trusted-ci-missing')
    expect(assessMerge({ ...facts, ci: { ...ci, runAttempt: 2 } }).reason).toBe('owner-approval-missing')
    expect(assessMerge({ ...facts, approval: { ...approval, runId: 'different-run' } }).reason)
      .toBe('owner-approval-missing')
  })

  it('refuses before spending when the live base moves during the final check', async () => {
    const api = { currentSnapshot: vi.fn(async () => ({ ...target, baseRef: 'release' })),
      consumeApproval: vi.fn(async () => true), merge: vi.fn(async () => {}) }
    await expect(executeMerge(facts, api)).rejects.toThrow('PR head or base changed')
    expect(api.consumeApproval).not.toHaveBeenCalled()
    expect(api.merge).not.toHaveBeenCalled()
  })

  it('passes the complete expected snapshot to an atomic merge adapter', async () => {
    const api = { currentSnapshot: vi.fn(async () => target), consumeApproval: vi.fn(async () => true),
      merge: vi.fn(async (_snapshot: typeof target) => {}) }
    await executeMerge(facts, api)
    expect(api.consumeApproval).toHaveBeenCalledWith(approval)
    expect(api.merge).toHaveBeenCalledExactlyOnceWith(target)
  })
})
