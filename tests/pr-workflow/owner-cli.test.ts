import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixedComment, runOwnerCommand } from '../../src/pr-workflow/owner-cli.js'
import type { ReviewReceipt } from '../../src/pr-workflow/store.js'
import { ensureBuiltCli } from '../support/built-cli.js'

const diff = 'diff --git a/notes b/notes\n+ready\n'
const receipt: ReviewReceipt = { kind: 'review-completed', repo: 'owner/project', number: 12, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40), runId: '599845b6-4408-4eae-9b35-036d78362b44',
  diffSha256: createHash('sha256').update(diff).digest('hex'), mergeProposed: true }
const ci = { workflowId: 123, workflowSha: 'c'.repeat(40), runId: 42, runAttempt: 1, artifactId: 100,
  artifactDigest: 'sha256:' + 'e'.repeat(64) }
const env = { CORDON_PR_TRUSTED_WORKFLOW_ID: String(ci.workflowId), CORDON_PR_TRUSTED_WORKFLOW_SHA: ci.workflowSha,
  CORDON_PR_TRUSTED_WORKFLOW_REF: 'main' }
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
  it('records the exact historical snapshot and excludes review text', () => {
    const input = { ...receipt, title: 'Page layout', body: 'Changes the navigation', reviewText: 'Looks good' }
    expect(fixedComment(input)).toBe([
      'Cordon recorded a review of this snapshot of PR #12.',
      '',
      `- Head SHA: \`${receipt.headSha}\``,
      `- Base: \`refs/heads/main\` at \`${receipt.baseSha}\``,
      `- Diff SHA-256: \`${receipt.diffSha256}\``,
      '',
      'The PR may have changed since this review.',
    ].join('\n'))
  })

  it('escapes the branch name inside the fixed text', () => {
    const text = fixedComment({ ...receipt, baseRef: 'topic/patch`<@owner>' })
    expect(text).toContain('refs/heads/topic/patch%60%3C%40owner%3E')
    expect(text).not.toContain('@owner')
  })

  it('rejects invalid PR numbers, SHAs and diff digests', () => {
    expect(() => fixedComment({ ...receipt, number: 0 })).toThrow()
    expect(() => fixedComment({ ...receipt, headSha: 'main' })).toThrow()
    expect(() => fixedComment({ ...receipt, baseSha: 'main' })).toThrow()
    expect(() => fixedComment({ ...receipt, diffSha256: 'abc' })).toThrow()
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

  it('refuses merge before opening a receipt or approval store', () => {
    expect(() => runOwnerCommand(['merge', '/missing-review-receipt'])).toThrow('owner actions are disabled')
  })

  function ownerFixture() {
    const root = scratch()
    const path = join(root, 'review.json')
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 })
    const owner = join(root, 'approvals')
    const access = {
      getPullSnapshot: vi.fn(() => ({ ...receipt, title: '', body: '' })),
      getPinnedDiff: vi.fn(() => diff),
      readTrustedCi: vi.fn(() => ci),
      publishReviewComment: vi.fn(() => ({ commentId: 876, published: true })),
    }
    const run = (command: 'check' | 'approve' | 'comment') =>
      runOwnerCommand([command, path, owner, '42', '1'], env, access)
    return { path, owner, run, access }
  }

  it('checks and issues approval only for the exact current candidate and authenticated CI', () => {
    const { run, access } = ownerFixture()
    expect(run('check')).toMatchObject({ allow: false, reason: 'owner-approval-missing' })
    expect(run('approve')).toMatchObject({ allow: true, reason: 'approval-issued' })
    expect(run('check')).toMatchObject({ allow: true, reason: 'approved' })
    expect(access.readTrustedCi).toHaveBeenCalledWith(receipt, 42, {
      workflowId: 123, workflowSha: ci.workflowSha, workflowRef: 'main', runAttempt: 1,
    })
  })

  it('publishes a completed review without requiring a merge proposal', () => {
    const { path, owner, run, access } = ownerFixture()
    const reviewed = { ...receipt, mergeProposed: false }
    writeFileSync(path, JSON.stringify(reviewed))
    expect(run('comment')).toMatchObject({ allow: true, reason: 'comment-published', commentId: 876 })
    expect(access.publishReviewComment).toHaveBeenCalledExactlyOnceWith(owner, reviewed)
  })

  it('leaves a live merge approval intact when publishing a comment', () => {
    const { run } = ownerFixture()
    const before = run('approve')
    if (!('approval' in before)) throw new Error('expected an issued approval')
    expect(run('comment')).toMatchObject({ allow: true, reason: 'comment-published' })
    expect(run('check')).toMatchObject({ allow: true, reason: 'approved', approval: before.approval })
  })

  it('returns the original comment ID on repeat', () => {
    const { run, access } = ownerFixture()
    access.publishReviewComment.mockReturnValueOnce({ commentId: 876, published: false })
    expect(run('comment')).toMatchObject({ allow: true, reason: 'comment-already-present', commentId: 876 })
  })

  it('refuses publication when the snapshot changes during verification', () => {
    const { run, access } = ownerFixture()
    access.getPullSnapshot.mockReturnValueOnce({ ...receipt, title: '', body: '' })
      .mockReturnValueOnce({ ...receipt, baseSha: '7'.repeat(40), title: '', body: '' })
    expect(run('comment')).toMatchObject({ allow: false, reason: 'snapshot-changed' })
    expect(access.publishReviewComment).not.toHaveBeenCalled()
  })

  it('refuses publication when CI evidence cannot be authenticated', () => {
    const { run, access } = ownerFixture()
    access.readTrustedCi.mockImplementationOnce(() => { throw new Error('invalid CI evidence') })
    expect(() => run('comment')).toThrow('invalid CI evidence')
    expect(access.publishReviewComment).not.toHaveBeenCalled()
  })

  it('refuses the same head after a base retarget', () => {
    const { run, access } = ownerFixture()
    run('approve')
    access.getPullSnapshot.mockReturnValue({ ...receipt, baseRef: 'release', title: '', body: '' })
    expect(run('check')).toMatchObject({ allow: false, reason: 'snapshot-changed' })
    expect(access.readTrustedCi).toHaveBeenCalledTimes(1)
  })

  it('rechecks the base after verifying CI before issuing an approval', () => {
    const { run, access } = ownerFixture()
    access.getPullSnapshot.mockReturnValueOnce({ ...receipt, title: '', body: '' })
      .mockReturnValueOnce({ ...receipt, baseSha: '7'.repeat(40), title: '', body: '' })
    expect(run('approve')).toMatchObject({ allow: false, reason: 'snapshot-changed' })
    expect(run('check')).toMatchObject({ allow: false, reason: 'owner-approval-missing' })
  })

  it('refuses a different diff without reading CI', () => {
    const { run, access } = ownerFixture()
    access.getPinnedDiff.mockReturnValueOnce(diff + 'different content')
    expect(run('approve')).toMatchObject({ allow: false, reason: 'diff-changed' })
    expect(access.readTrustedCi).not.toHaveBeenCalled()
  })

  it('refuses a receipt without completed evidence or without a pinned base', () => {
    const { path, run, access } = ownerFixture()
    writeFileSync(path, JSON.stringify({ ...receipt, kind: 'diff-read' }))
    expect(() => run('check')).toThrow('invalid completed review receipt')
    writeFileSync(path, JSON.stringify({ ...receipt, baseRef: undefined, baseSha: undefined }))
    expect(() => run('check')).toThrow('invalid completed review receipt')
    expect(access.getPullSnapshot).not.toHaveBeenCalled()
  })
})
