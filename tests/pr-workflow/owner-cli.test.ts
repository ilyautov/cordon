import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fixedComment, runOwnerCommand } from '../../src/pr-workflow/owner-cli.js'
import { approveReceipt, approvalForReceipt, consumeReceiptApproval } from '../../src/pr-workflow/owner-approvals.js'
import type { ReviewReceipt } from '../../src/pr-workflow/store.js'
import { ensureBuiltCli } from '../support/built-cli.js'

const receipt: ReviewReceipt = { kind: 'review-completed', repo: 'owner/project', number: 12, headSha: 'a'.repeat(40),
  runId: '599845b6-4408-4eae-9b35-036d78362b44', diffSha256: '1'.repeat(64), mergeProposed: true }
const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cordon-owner-draft-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('fixed owner comment', () => {
  it('includes the reviewed number and head while ignoring other review text', () => {
    const input = { ...receipt, title: 'Page layout', body: 'Changes the navigation', reviewText: 'Looks good' }
    expect(fixedComment(input)).toBe(
      `Automated review was recorded for PR #12 at ${receipt.headSha}. ` +
      'This comment contains no agent output; the owner must inspect the review and the diff.',
    )
  })

  it('rejects invalid PR numbers and head SHAs', () => {
    expect(() => fixedComment({ ...receipt, number: 0 })).toThrow('invalid PR number')
    expect(() => fixedComment({ ...receipt, headSha: 'main' })).toThrow('invalid PR head SHA')
  })
})

describe('draft owner CLI', () => {
  it.skipIf(process.platform === 'win32')('reports a refusal when invoked through a symlink', () => {
    ensureBuiltCli()
    const executable = fileURLToPath(new URL('../../dist/pr-workflow/owner-cli.js', import.meta.url))
    const link = join(scratch(), 'owner-cli.js')
    symlinkSync(executable, link)
    const result = spawnSync(process.execPath, [link, 'merge', '/missing-review-receipt'], {
      encoding: 'utf8', timeout: 5000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('owner actions are disabled')
  })

  it.each(['approve', 'comment', 'merge'])('refuses %s before opening a receipt or approval store', (command) => {
    expect(() => runOwnerCommand([command, '/missing-review-receipt'])).toThrow('owner actions are disabled')
  })

  it('only reports a finalized local receipt and keeps the decision closed', () => {
    const path = join(scratch(), 'review.json')
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 })
    expect(runOwnerCommand(['check', path])).toEqual({ allow: false, reason: 'owner-actions-draft', receipt })
  })

  it('refuses an incomplete review record', () => {
    const path = join(scratch(), 'review.json')
    writeFileSync(path, JSON.stringify({ ...receipt, kind: 'diff-read' }), { mode: 0o600 })
    expect(() => runOwnerCommand(['check', path])).toThrow()
  })
})

describe('draft owner approval storage', () => {
  it('spends approval only once and only for the exact completed receipt', () => {
    const root = scratch()
    approveReceipt(root, receipt, 1_000)
    const otherRun = { ...receipt, runId: '89566ef7-b0ad-4ada-923f-595988ea5209' }
    const otherDiff = { ...receipt, diffSha256: '2'.repeat(64) }
    expect(approvalForReceipt(root, receipt, 1_001)).toEqual({
      repo: receipt.repo, number: receipt.number, headSha: receipt.headSha,
      runId: receipt.runId, diffSha256: receipt.diffSha256,
    })
    expect(consumeReceiptApproval(root, otherRun, 1_001)).toBe(false)
    expect(consumeReceiptApproval(root, otherDiff, 1_001)).toBe(false)
    expect(consumeReceiptApproval(root, receipt, 1_001)).toBe(true)
    expect(consumeReceiptApproval(root, receipt, 1_001)).toBe(false)
  })

  it('rejects duplicate and expired approvals with the existing one-use store semantics', () => {
    const root = scratch()
    approveReceipt(root, receipt, 1_000)
    expect(() => approveReceipt(root, receipt, 1_001)).toThrow()
    expect(approvalForReceipt(root, receipt, 3_601_001)).toBeNull()
    expect(consumeReceiptApproval(root, receipt, 3_601_001)).toBe(false)
  })
})
