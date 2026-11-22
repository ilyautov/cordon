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

  it.each(['comment', 'merge'])('refuses %s before opening a receipt or approval store', (command) => {
    expect(() => runOwnerCommand([command, '/missing-review-receipt'])).toThrow('owner actions are disabled')
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
    }
    const run = (command: 'check' | 'approve') => runOwnerCommand([command, path, owner, '42', '1'], env, access)
    return { path, run, access }
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
