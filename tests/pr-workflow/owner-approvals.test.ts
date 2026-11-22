import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalForReceipt, approveReceipt, consumeReceiptApproval, sameCiIdentity, sameReview,
  type CiIdentity } from '../../src/pr-workflow/owner-approvals.js'
import type { ReviewReceipt } from '../../src/pr-workflow/store.js'

const receipt: ReviewReceipt = { kind: 'review-completed', repo: 'owner/project', number: 12,
  baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40),
  runId: '599845b6-4408-4eae-9b35-036d78362b44', diffSha256: '1'.repeat(64), mergeProposed: true }
const ci: CiIdentity = { workflowId: 1, workflowSha: 'c'.repeat(40), runId: 42,
  runAttempt: 1, artifactId: 77, artifactDigest: '2'.repeat(64) }
const profile = { baseRef: 'main', statusAppId: 17, statusAppSlug: 'cordon-ci',
  statusContext: 'cordon/quality', mergeAppId: 41 }
const mergePolicy = { profile, rulesSha256: '5'.repeat(64), repositoryId: 123 }
const issuedAt = 1_000
const renewalAt = issuedAt + 3_600_001
const roots: string[] = []
let beforeLink: ((source: string, destination: string) => void) | undefined

vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return {
    ...real,
    linkSync: (source: fs.PathLike, destination: fs.PathLike) => {
      const step = beforeLink
      beforeLink = undefined
      step?.(String(source), String(destination))
      real.linkSync(source, destination)
    },
  }
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cordon-owner-approval-test-'))
  roots.push(root)
  return root
}

function onlyRecord(root: string): string {
  const records = readdirSync(root).filter((name) => name.endsWith('.json'))
  expect(records).toHaveLength(1)
  return join(root, records[0]!)
}

afterEach(() => {
  beforeLink = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('PR owner approval generations', () => {
  it('binds the receipt and CI proof and rejects duplicate active issuance', () => {
    const root = scratch()
    const record = approveReceipt(root, receipt, ci, issuedAt)
    expect(approvalForReceipt(root, receipt, ci, issuedAt + 1)).toEqual(record)
    expect(record).toMatchObject({ baseRef: receipt.baseRef, baseSha: receipt.baseSha,
      headSha: receipt.headSha, runId: receipt.runId, diffSha256: receipt.diffSha256, ci, approvedAt: issuedAt })
    expect(record.generation).toBeTruthy()
    expect(() => approveReceipt(root, receipt, ci, issuedAt + 2)).toThrow(/active/)
  })

  it('requires an exact base, diff and CI proof when checking or consuming', () => {
    const root = scratch()
    const record = approveReceipt(root, receipt, ci, issuedAt)
    const changedReceipts = [{ ...receipt, baseRef: 'release' }, { ...receipt, baseSha: 'd'.repeat(40) },
      { ...receipt, diffSha256: '3'.repeat(64) }]
    const changedProofs = [{ ...ci, workflowId: 2 }, { ...ci, workflowSha: 'e'.repeat(40) },
      { ...ci, runId: 43 }, { ...ci, runAttempt: 2 }, { ...ci, artifactId: 78 },
      { ...ci, artifactDigest: '4'.repeat(64) }]
    for (const candidate of changedReceipts) {
      expect(approvalForReceipt(root, candidate, ci, issuedAt + 1)).toBeNull()
      expect(consumeReceiptApproval(root, candidate, ci, record, issuedAt + 1)).toBe(false)
    }
    expect(sameCiIdentity(ci, { ...ci })).toBe(true)
    for (const proof of changedProofs) {
      expect(sameCiIdentity(ci, proof)).toBe(false)
      expect(approvalForReceipt(root, receipt, proof, issuedAt + 1)).toBeNull()
      expect(consumeReceiptApproval(root, receipt, proof, record, issuedAt + 1)).toBe(false)
    }
    expect(approvalForReceipt(root, receipt, ci, issuedAt + 1)).toEqual(record)
  })

  it('binds every merge-policy field and accepts the same policy in a different key order', () => {
    const root = scratch()
    const guarded = { ...receipt, mergePolicy }
    const record = approveReceipt(root, guarded, ci, issuedAt)
    expect(record).toMatchObject({ mergePolicy })
    const orderedDifferently = { ...receipt, mergePolicy: { repositoryId: mergePolicy.repositoryId,
      rulesSha256: mergePolicy.rulesSha256,
      profile: { mergeAppId: profile.mergeAppId, statusContext: profile.statusContext,
        statusAppSlug: profile.statusAppSlug, statusAppId: profile.statusAppId, baseRef: profile.baseRef } } }
    expect(approvalForReceipt(root, orderedDifferently, ci, issuedAt + 1)).toEqual(record)
    for (const changed of [{ ...mergePolicy, rulesSha256: '6'.repeat(64) },
      { ...mergePolicy, repositoryId: 124 },
      { ...mergePolicy, profile: { ...profile, statusAppId: 18 } },
      { ...mergePolicy, profile: { ...profile, statusAppSlug: 'other-ci' } },
      { ...mergePolicy, profile: { ...profile, statusContext: 'other/quality' } },
      { ...mergePolicy, profile: { ...profile, mergeAppId: 42 } }]) {
      const candidate = { ...receipt, mergePolicy: changed }
      expect(sameReview(candidate, guarded)).toBe(false)
      expect(approvalForReceipt(root, candidate, ci, issuedAt + 1)).toBeNull()
      expect(consumeReceiptApproval(root, candidate, ci, record, issuedAt + 1)).toBe(false)
    }
    expect(sameReview({ ...guarded, mergePolicy: { ...mergePolicy, profile: { ...profile, baseRef: 'release' } } },
      guarded)).toBe(false)
    expect(consumeReceiptApproval(root, orderedDifferently, ci, record, issuedAt + 1)).toBe(true)
  })

  it('keeps an existing policy-free approval usable without granting it to a guarded receipt', () => {
    const root = scratch()
    const { repo, number, headSha, baseRef, baseSha, runId, diffSha256 } = receipt
    const legacyBinding = { repo, number, headSha, baseRef, baseSha, runId, diffSha256, ci }
    const prefix = createHash('sha256').update(JSON.stringify(legacyBinding)).digest('hex')
    const legacy = { ...legacyBinding, generation: 'daecbb31-adab-48b4-8675-d202a0c6e788', approvedAt: issuedAt }
    writeFileSync(join(root, `${prefix}.1.json`), JSON.stringify(legacy), { mode: 0o600 })
    const guarded = { ...receipt, mergePolicy }
    expect(approvalForReceipt(root, receipt, ci, issuedAt + 1)).toEqual(legacy)
    expect(sameReview(legacy, guarded)).toBe(false)
    expect(sameReview(guarded, legacy)).toBe(false)
    expect(approvalForReceipt(root, guarded, ci, issuedAt + 1)).toBeNull()
    const guardedApproval = approveReceipt(root, guarded, ci, issuedAt)
    expect(consumeReceiptApproval(root, guarded, ci, legacy, issuedAt + 1)).toBe(false)
    expect(consumeReceiptApproval(root, receipt, ci, guardedApproval, issuedAt + 1)).toBe(false)
    expect(consumeReceiptApproval(root, receipt, ci, legacy, issuedAt + 1)).toBe(true)
    expect(approvalForReceipt(root, guarded, ci, issuedAt + 1)).toEqual(guardedApproval)
  })

  it('rejects a malformed direct policy or a policy for a different base', () => {
    const root = scratch()
    const approval = approveReceipt(root, { ...receipt, mergePolicy }, ci, issuedAt)
    for (const invalid of [{ ...mergePolicy, rulesSha256: 'bad-hash' },
      { ...mergePolicy, profile: { ...profile, baseRef: 'release' } }]) {
      const invalidReceipt = { ...receipt, mergePolicy: invalid }
      expect(() => approvalForReceipt(root, invalidReceipt, ci, issuedAt + 1)).toThrow('invalid merge policy')
      expect(() => approveReceipt(root, invalidReceipt, ci, issuedAt + 1)).toThrow('invalid merge policy')
      expect(() => consumeReceiptApproval(root, invalidReceipt, ci, approval, issuedAt + 1))
        .toThrow('invalid merge policy')
    }
  })

  it('refuses a saved approval whose merge policy no longer matches its binding', () => {
    const root = scratch()
    const guarded = { ...receipt, mergePolicy }
    const record = approveReceipt(root, guarded, ci, issuedAt)
    writeFileSync(onlyRecord(root), JSON.stringify({ ...record,
      mergePolicy: { ...mergePolicy, rulesSha256: '6'.repeat(64) } }))
    expect(() => approvalForReceipt(root, guarded, ci, issuedAt + 1)).toThrow('invalid approval record')
    expect(() => consumeReceiptApproval(root, guarded, ci, record, issuedAt + 1)).toThrow('invalid approval record')
  })

  it('renews an expired approval and prevents a stale reader from consuming the renewal', () => {
    const root = scratch()
    const retired = approveReceipt(root, receipt, ci, issuedAt)
    expect(approvalForReceipt(root, receipt, ci, renewalAt)).toBeNull()
    const renewed = approveReceipt(root, receipt, ci, renewalAt)
    expect(renewed.generation).not.toBe(retired.generation)
    expect(consumeReceiptApproval(root, receipt, ci, retired, renewalAt + 1)).toBe(false)
    expect(approvalForReceipt(root, receipt, ci, renewalAt + 1)).toEqual(renewed)
    expect(consumeReceiptApproval(root, receipt, ci, renewed, renewalAt + 1)).toBe(true)
  })

  it('spends each issued generation only once even when a new one is granted immediately', () => {
    const root = scratch()
    const spent = approveReceipt(root, receipt, ci, issuedAt)
    expect(consumeReceiptApproval(root, receipt, ci, spent, issuedAt + 1)).toBe(true)
    expect(approvalForReceipt(root, receipt, ci, issuedAt + 1)).toBeNull()
    const issued = approveReceipt(root, receipt, ci, issuedAt + 1)
    expect(consumeReceiptApproval(root, receipt, ci, spent, issuedAt + 1)).toBe(false)
    expect(consumeReceiptApproval(root, receipt, ci, issued, issuedAt + 2)).toBe(true)
    expect(consumeReceiptApproval(root, receipt, ci, issued, issuedAt + 2)).toBe(false)
  })

  it('keeps only one renewal when two issuers publish after expiry', () => {
    const root = scratch()
    approveReceipt(root, receipt, ci, issuedAt)
    beforeLink = () => {
      beforeLink = () => { approveReceipt(root, receipt, ci, renewalAt) }
    }
    expect(() => approveReceipt(root, receipt, ci, renewalAt)).toThrow(/already active|changed/)
    expect(approvalForReceipt(root, receipt, ci, renewalAt)?.approvedAt).toBe(renewalAt)
  })

  it('lets only one of two consumers claim the same active generation', () => {
    const root = scratch()
    const record = approveReceipt(root, receipt, ci, issuedAt)
    let otherConsumed = false
    beforeLink = () => { otherConsumed = consumeReceiptApproval(root, receipt, ci, record, issuedAt + 1) }
    expect(consumeReceiptApproval(root, receipt, ci, record, issuedAt + 1)).toBe(false)
    expect(otherConsumed).toBe(true)
    expect(approvalForReceipt(root, receipt, ci, issuedAt + 1)).toBeNull()
  })

  it('prevents an already-started consume from spending a generation that renewal retired', () => {
    const root = scratch()
    const original = approveReceipt(root, receipt, ci, issuedAt)
    beforeLink = () => { approveReceipt(root, receipt, ci, renewalAt) }
    expect(consumeReceiptApproval(root, receipt, ci, original, renewalAt - 1)).toBe(false)
    expect(approvalForReceipt(root, receipt, ci, renewalAt)?.generation).not.toBe(original.generation)
  })

  it('refuses corrupt records and follows no symbolic links when checking or issuing', () => {
    const root = scratch()
    const original = approveReceipt(root, receipt, ci, issuedAt)
    const path = onlyRecord(root)
    writeFileSync(path, '{')
    expect(() => approvalForReceipt(root, receipt, ci, issuedAt + 1)).toThrow(/invalid approval record/)
    expect(() => approveReceipt(root, receipt, ci, renewalAt)).toThrow(/invalid approval record/)
    rmSync(path)
    const other = join(root, 'ordinary-file')
    writeFileSync(other, JSON.stringify(original), { mode: 0o600 })
    symlinkSync(other, path)
    expect(() => approvalForReceipt(root, receipt, ci, issuedAt + 1)).toThrow()
    expect(() => consumeReceiptApproval(root, receipt, ci, original, issuedAt + 1)).toThrow()
  })

  it('refuses a substituted regular file or symlink at the close step', () => {
    for (const asSymlink of [false, true]) {
      const root = scratch()
      const original = approveReceipt(root, receipt, ci, issuedAt)
      beforeLink = (source) => {
        rmSync(source)
        const replacement = join(root, 'different-inode')
        writeFileSync(replacement, JSON.stringify(original), { mode: 0o600, flag: 'wx' })
        if (asSymlink) symlinkSync(replacement, source)
        else fs.copyFileSync(replacement, source)
      }
      expect(() => consumeReceiptApproval(root, receipt, ci, original, issuedAt + 1))
        .toThrow(/invalid approval closure|approval record changed before claim/)
    }
  })
})
