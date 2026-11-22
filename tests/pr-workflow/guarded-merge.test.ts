import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as owner from '../../src/pr-workflow/owner-cli.js'
import { approvalForReceipt } from '../../src/pr-workflow/owner-approvals.js'
import type { MergePolicyEvidence, PrTarget, ReviewReceipt } from '../../src/pr-workflow/store.js'

const diff = 'diff --git a/notes b/notes\n+new note\n'
const target: PrTarget = { repo: 'owner/project', number: 12, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40) }
const mergePolicy = {
  repositoryId: 987, rulesSha256: 'e'.repeat(64),
  profile: { baseRef: 'main', statusAppId: 15368, statusAppSlug: 'github-actions',
    statusContext: 'cordon/exact-snapshot', mergeAppId: 456 },
} satisfies MergePolicyEvidence
const receipt = { kind: 'review-completed', ...target, runId: '599845b6-4408-4eae-9b35-036d78362b44',
  diffSha256: createHash('sha256').update(diff).digest('hex'), mergeProposed: true, mergePolicy } satisfies ReviewReceipt
const ci = { workflowId: 123, workflowSha: 'c'.repeat(40), runId: 42, runAttempt: 1, artifactId: 100,
  artifactDigest: 'sha256:' + 'b'.repeat(64) }
const env = { CORDON_PR_TRUSTED_WORKFLOW_ID: '123', CORDON_PR_TRUSTED_WORKFLOW_SHA: ci.workflowSha,
  CORDON_PR_TRUSTED_WORKFLOW_REF: 'main', CORDON_PR_MERGE_APP_KEY_FILE: '/owner/merge.private-key.pem' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(input: ReviewReceipt = receipt) {
  const root = mkdtempSync(join(tmpdir(), 'cordon-guarded-merge-'))
  roots.push(root)
  const receiptFile = join(root, 'receipt.json')
  writeFileSync(receiptFile, JSON.stringify(input), { mode: 0o600 })
  const approvalDir = join(root, 'approvals')
  const snapshot = { ...target, title: '', body: '' }
  const access = {
    getPullSnapshot: vi.fn(() => snapshot),
    getPinnedDiff: vi.fn(() => diff),
    readTrustedCi: vi.fn(() => ci),
    publishReviewComment: vi.fn(() => ({ commentId: 1, published: true })),
  }
  const merge = vi.fn(async (_target: PrTarget) => 'd'.repeat(40))
  const protection = {
    captureMergePolicy: vi.fn(() => mergePolicy),
    verifyMergeHead: vi.fn(),
    openMergeApp: vi.fn(async () => ({ merge })),
  }
  const args = [receiptFile, approvalDir, String(ci.runId), String(ci.runAttempt)]
  return { approvalDir, snapshot, access, merge, protection, args,
    approve: () => owner.runOwnerCommand(['approve', ...args], env, access, protection),
    attempt: () => owner.runGuardedMergeCommand(['merge', ...args], env, access, protection) }
}

describe('guarded owner merge', () => {
  it('spends only the merge approval and submits the exact protected snapshot to the App', async () => {
    const { approve, attempt, protection, merge, approvalDir } = fixture()
    expect(typeof owner.runGuardedMergeCommand).toBe('function')
    expect(approve()).toMatchObject({ allow: true, reason: 'approval-issued' })
    expect(await attempt()).toEqual({ allow: true, reason: 'merged', mergeSha: 'd'.repeat(40) })
    expect(protection.openMergeApp).toHaveBeenCalledExactlyOnceWith(target, 987, 456, env.CORDON_PR_MERGE_APP_KEY_FILE)
    expect(merge).toHaveBeenCalledExactlyOnceWith(target)
    expect(approvalForReceipt(approvalDir, receipt, ci)).toBeNull()
  })

  it('requires the rules to have been pinned in the original review', async () => {
    const { mergePolicy: _omitted, ...legacy } = receipt
    const { approve, attempt, protection } = fixture(legacy)
    expect(approve()).toMatchObject({ allow: true })
    await expect(attempt()).rejects.toThrow(/protection pinned during review/u)
    expect(protection.openMergeApp).not.toHaveBeenCalled()
  })

  it('refuses when rules drift while issuing App credentials and preserves the approval', async () => {
    const { approve, attempt, protection, merge, approvalDir } = fixture()
    approve()
    protection.captureMergePolicy.mockReturnValueOnce(mergePolicy)
      .mockReturnValueOnce({ ...mergePolicy, rulesSha256: 'f'.repeat(64) })
    await expect(attempt()).rejects.toThrow(/protection changed/u)
    expect(merge).not.toHaveBeenCalled()
    expect(approvalForReceipt(approvalDir, receipt, ci)).not.toBeNull()
  })

  it.each([
    { headSha: 'f'.repeat(40) },
    { baseSha: 'f'.repeat(40) },
    { baseRef: 'alternate' },
  ])('rejects late drift in %j without spending approval or merging', async (drift) => {
    const { approve, attempt, access, snapshot, merge, approvalDir } = fixture()
    approve()
    access.getPullSnapshot.mockReturnValueOnce(snapshot).mockReturnValueOnce(snapshot)
      .mockReturnValueOnce({ ...snapshot, ...drift })
    await expect(attempt()).rejects.toThrow(/head or base changed/u)
    expect(merge).not.toHaveBeenCalled()
    expect(approvalForReceipt(approvalDir, receipt, ci)).not.toBeNull()
  })

  it('rechecks the approved trusted CI identity after obtaining App credentials', async () => {
    const { approve, attempt, access, merge, approvalDir } = fixture()
    approve()
    access.readTrustedCi.mockReturnValueOnce(ci).mockReturnValueOnce({ ...ci, artifactId: ci.artifactId + 1 })
    await expect(attempt()).rejects.toThrow(/trusted CI changed/u)
    expect(merge).not.toHaveBeenCalled()
    expect(approvalForReceipt(approvalDir, receipt, ci)).not.toBeNull()
  })

  it('rejects rule drift before issuing an approval', () => {
    const { approve, protection, approvalDir } = fixture()
    protection.captureMergePolicy.mockReturnValueOnce({ ...mergePolicy, rulesSha256: 'f'.repeat(64) })
    expect(approve).toThrow(/protection changed/u)
    expect(approvalForReceipt(approvalDir, receipt, ci)).toBeNull()
  })
})
