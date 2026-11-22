import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewReceipt } from './store.js'

export type ApprovalTarget = Pick<ReviewReceipt, 'repo' | 'number' | 'headSha' | 'runId' | 'diffSha256'>
type Approval = ApprovalTarget & { approvedAt: number }
const ttlMs = 60 * 60 * 1_000

export function sameReview(left: ApprovalTarget, right: ApprovalTarget): boolean {
  return left.repo === right.repo && left.number === right.number && left.headSha === right.headSha &&
    left.runId === right.runId && left.diffSha256 === right.diffSha256
}

function privateRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('approval directory must be private')
}

function identity(receipt: ReviewReceipt): ApprovalTarget {
  return { repo: receipt.repo, number: receipt.number, headSha: receipt.headSha,
    runId: receipt.runId, diffSha256: receipt.diffSha256 }
}

function approvalPath(root: string, target: ApprovalTarget): string {
  const id = createHash('sha256').update(JSON.stringify(target)).digest('hex')
  return join(root, `${id}.json`)
}

function readApproval(path: string, target: ApprovalTarget, now: number): Approval | null {
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('invalid approval record')
  const record: Approval = JSON.parse(readFileSync(path, 'utf8'))
  if (record === null || !sameReview(record, target) || !Number.isSafeInteger(record.approvedAt)) {
    throw new Error('invalid approval record')
  }
  return now >= record.approvedAt && now - record.approvedAt <= ttlMs ? record : null
}

// Draft store only. Owner commands remain disabled until the approval also
// binds the checked base and trusted CI result, with an atomic reissue path.
export function approveReceipt(root: string, receipt: ReviewReceipt, now = Date.now()): void {
  if (!receipt.mergeProposed) throw new Error('the review did not propose merge')
  privateRoot(root)
  const target = identity(receipt)
  writeFileSync(approvalPath(root, target), JSON.stringify({ ...target, approvedAt: now }), {
    mode: 0o600, flag: 'wx',
  })
}

export function approvalForReceipt(root: string, receipt: ReviewReceipt, now = Date.now()): ApprovalTarget | null {
  privateRoot(root)
  const target = identity(receipt)
  const path = approvalPath(root, target)
  return existsSync(path) && readApproval(path, target, now) !== null ? target : null
}

export function consumeReceiptApproval(root: string, receipt: ReviewReceipt, now = Date.now()): boolean {
  privateRoot(root)
  const target = identity(receipt)
  const source = approvalPath(root, target)
  const claimed = join(root, `${randomUUID()}.spent`)
  try { renameSync(source, claimed) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }

  try {
    return readApproval(claimed, target, now) !== null
  } finally {
    unlinkSync(claimed)
  }
}
