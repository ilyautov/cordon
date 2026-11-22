import { chmodSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendReviewEvent, publishReviewReceipt, readReviewEvents, readReviewReceipt } from '../../src/pr-workflow/store.js'

const target = { repo: 'owner/project', number: 12, headSha: 'a'.repeat(40), baseRef: 'main', baseSha: 'b'.repeat(40) }
const diffSha256 = 'b'.repeat(64)
const receipt = { ...target, kind: 'review-completed' as const, diffSha256,
  runId: '00000000-0000-4000-8000-000000000001', mergeProposed: true }

describe('local PR review records', () => {
  it('keeps staged evidence separate from completed receipts', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-records-'))
    const ledger = join(root, 'reads.jsonl')
    const event = { kind: 'diff-read' as const, ...target, diffSha256 }
    appendReviewEvent(ledger, event)
    expect(readReviewEvents(ledger)).toEqual([event])
    expect(() => readReviewReceipt(ledger)).toThrow(/invalid completed review receipt/)
    writeFileSync(ledger, 'partial\n')
    expect(() => readReviewEvents(ledger)).toThrow(/invalid staged review evidence/)
  })

  it('never follows a symlink for the receipt or staging file', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-records-'))
    const targetFile = join(root, 'other.txt')
    writeFileSync(targetFile, 'unchanged', { mode: 0o600 })
    const linked = join(root, 'linked.json')
    symlinkSync(targetFile, linked)
    expect(() => publishReviewReceipt(linked, receipt)).toThrow()
    expect(() => readReviewReceipt(linked)).toThrow()
    expect(() => appendReviewEvent(linked, { kind: 'merge-proposed', ...target, diffSha256 })).toThrow()
    expect(readFileSync(targetFile, 'utf8')).toBe('unchanged')
  })

  it('publishes a private receipt once and never replaces an existing record', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-records-'))
    const output = join(root, 'receipt.json')
    publishReviewReceipt(output, receipt)
    expect(readReviewReceipt(output)).toEqual(receipt)
    expect(() => publishReviewReceipt(output, { ...receipt, mergeProposed: false })).toThrow()
    expect(readReviewReceipt(output)).toEqual(receipt)
    expect(readdirSync(root)).toEqual(['receipt.json'])
    chmodSync(output, 0o666)
    expect(() => readReviewReceipt(output)).toThrow(/invalid completed review receipt/)
  })
})
