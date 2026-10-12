import { chmodSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendReviewEvent, readReviewEvents, approveHead, approvalFor, consumeApproval } from '../../src/pr-workflow/store.js'

const target = { repo: 'owner/project', number: 12, headSha: 'a'.repeat(40) }

describe('owner-only PR records', () => {
  it('records only structured evidence and refuses a corrupt ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-records-'))
    const ledger = join(root, 'reads.jsonl')
    appendReviewEvent(ledger, { kind: 'diff-read', ...target, diffSha256: 'b'.repeat(64) })
    expect(readReviewEvents(ledger)).toEqual([{ kind: 'diff-read', ...target, diffSha256: 'b'.repeat(64) }])
    expect(readFileSync(ledger, 'utf8')).not.toContain('PR title')
    writeFileSync(ledger, 'not json\n')
    expect(() => readReviewEvents(ledger)).toThrow(/invalid review ledger/)
  })

  it('never follows a ledger symlink, including a dangling one', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-records-'))
    const targetFile = join(root, 'other.txt')
    writeFileSync(targetFile, 'unchanged')
    const linked = join(root, 'linked.jsonl')
    symlinkSync(targetFile, linked)
    const event = { kind: 'merge-proposed' as const, ...target }
    expect(() => appendReviewEvent(linked, event)).toThrow()
    expect(readFileSync(targetFile, 'utf8')).toBe('unchanged')
    const dangling = join(root, 'dangling.jsonl')
    symlinkSync(join(root, 'missing.txt'), dangling)
    expect(() => appendReviewEvent(dangling, event)).toThrow()
  })

  it('refuses a ledger or approval file writable by another account', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-records-'))
    const ledger = join(root, 'reads.jsonl')
    appendReviewEvent(ledger, { kind: 'merge-proposed', ...target })
    chmodSync(ledger, 0o666)
    expect(() => readReviewEvents(ledger)).toThrow(/invalid review ledger/)
    const approvals = join(root, 'approvals')
    approveHead(approvals, target, 1_000)
    chmodSync(join(approvals, readdirSync(approvals)[0]!), 0o666)
    expect(() => approvalFor(approvals, target, 1_001)).toThrow(/invalid approval record/)
  })

  it('binds approval to one repo, PR and SHA, then spends it once', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-approval-'))
    approveHead(root, target, 1_000)
    expect(approvalFor(root, target, 1_001)).toEqual(target)
    expect(approvalFor(root, { ...target, headSha: 'c'.repeat(40) }, 1_001)).toBeNull()
    expect(consumeApproval(root, target, 1_001)).toBe(true)
    expect(consumeApproval(root, target, 1_001)).toBe(false)
  })

  it('rejects expired approval and duplicate approval for one head', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-approval-'))
    approveHead(root, target, 1_000)
    expect(() => approveHead(root, target, 1_001)).toThrow()
    expect(approvalFor(root, target, 3_601_001)).toBeNull()
    expect(consumeApproval(root, target, 3_601_001)).toBe(false)
  })
})
