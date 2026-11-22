import { describe, expect, it, vi } from 'vitest'
import { assessMerge, executeMerge } from '../../src/pr-workflow/merge.js'

const headSha = 'a'.repeat(40)
const target = { repo: 'owner/project', number: 12, headSha }
const receipt = { kind: 'review-completed' as const, ...target,
  runId: '599845b6-4408-4eae-9b35-036d78362b44', diffSha256: '1'.repeat(64), mergeProposed: true }
const facts = {
  ...target,
  receipt,
  status: { context: 'cordon-pr/quality', state: 'success', creator: { login: 'github-actions[bot]' },
    target_url: 'https://github.com/owner/project/actions/runs/42' },
  run: { id: 42, name: 'PR quality gate', conclusion: 'success', event: 'workflow_dispatch',
    head_sha: 'c'.repeat(40), head_branch: 'main', workflow_id: 123,
    repository: { full_name: target.repo } },
  approval: { ...receipt },
  trustedWorkflowId: 123,
  trustedContext: 'cordon-pr/quality',
}

describe('draft owner merge gate', () => {
  it('holds an apparently successful workflow reference without authenticated candidate evidence', () => {
    expect(assessMerge(facts)).toEqual({ allow: false, reason: 'owner-actions-draft' })
  })

  it('rejects a receipt for a different PR and a receipt without a proposal', () => {
    expect(assessMerge({ ...facts, receipt: { ...receipt, number: 13 } }).reason).toBe('invalid-review-receipt')
    expect(assessMerge({ ...facts, receipt: { ...receipt, mergeProposed: false } }).reason).toBe('not-proposed')
  })

  it('rejects owner approval for another run or diff at the same head', () => {
    expect(assessMerge({ ...facts, approval: { ...receipt, runId: 'different-run' } }).reason)
      .toBe('owner-approval-missing')
    expect(assessMerge({ ...facts, approval: { ...receipt, diffSha256: '2'.repeat(64) } }).reason)
      .toBe('owner-approval-missing')
  })

  it('never consumes approval or contacts a merge transport while the draft is disabled', async () => {
    const api = { currentHead: vi.fn(async () => headSha), consumeApproval: vi.fn(async () => true),
      merge: vi.fn(async (_sha: string) => {}) }
    await expect(executeMerge(facts, api)).rejects.toThrow('merge refused: owner-actions-draft')
    expect(api.currentHead).not.toHaveBeenCalled()
    expect(api.consumeApproval).not.toHaveBeenCalled()
    expect(api.merge).not.toHaveBeenCalled()
  })
})
