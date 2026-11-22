import { randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type PrTarget = { repo: string; number: number; headSha: string; baseRef: string; baseSha: string }
export type ReviewEvent = PrTarget & { kind: 'diff-read' | 'merge-proposed'; diffSha256: string }
export type ReviewReceipt = PrTarget & {
  kind: 'review-completed'
  runId: string
  diffSha256: string
  mergeProposed: boolean
}

const runIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

export function validatePrSelection(repo: string, number: number): void {
  if (typeof repo !== 'string' || !repoPattern.test(repo) || !Number.isSafeInteger(number) || number < 1 ||
    repo.split('/').some((part) => part === '.' || part === '..')) throw new Error('invalid PR target')
}

function validBaseRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 255 &&
    !ref.startsWith('-') && ref !== '@' && !ref.endsWith('.') && !ref.includes('..') && !ref.includes('@{') &&
    !Array.from(ref).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 ||
      '~^:?*[\\'.includes(char)) &&
    ref.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

export function validateTarget(target: PrTarget): void {
  validatePrSelection(target.repo, target.number)
  if (typeof target.headSha !== 'string' || !shaPattern.test(target.headSha) ||
    typeof target.baseSha !== 'string' || !shaPattern.test(target.baseSha) ||
    !validBaseRef(target.baseRef)) throw new Error('invalid PR snapshot')
}

export function sameSnapshot(left: PrTarget, right: PrTarget): boolean {
  return left.repo.toLowerCase() === right.repo.toLowerCase() && left.number === right.number &&
    left.headSha === right.headSha && left.baseRef === right.baseRef && left.baseSha === right.baseSha
}

function validEvent(value: unknown): value is ReviewEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<ReviewEvent>
  try { validateTarget(event as PrTarget) } catch { return false }
  return (event.kind === 'diff-read' || event.kind === 'merge-proposed') &&
    typeof event.diffSha256 === 'string' && digestPattern.test(event.diffSha256) &&
    Object.keys(event).length === 7
}

export function appendReviewEvent(path: string, event: ReviewEvent): void {
  if (!validEvent(event)) throw new Error('invalid review event')
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
    constants.O_NOFOLLOW, 0o600)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('review ledger must be a private regular file')
    writeFileSync(fd, JSON.stringify(event) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readPrivate(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('expected a private regular file')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

export function readReviewEvents(path: string): ReviewEvent[] {
  try {
    return readPrivate(path).split('\n').filter(Boolean).map((line) => {
      const event: unknown = JSON.parse(line)
      if (!validEvent(event)) throw new Error('invalid review event')
      return event
    })
  } catch {
    throw new Error('invalid staged review evidence')
  }
}

function validReceipt(value: unknown): value is ReviewReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Partial<ReviewReceipt>
  try { validateTarget(receipt as PrTarget) } catch { return false }
  return receipt.kind === 'review-completed' && Object.keys(receipt).length === 9 &&
    typeof receipt.runId === 'string' && runIdPattern.test(receipt.runId) &&
    typeof receipt.diffSha256 === 'string' && digestPattern.test(receipt.diffSha256) &&
    typeof receipt.mergeProposed === 'boolean'
}

export function readReviewReceipt(path: string): ReviewReceipt {
  try {
    const receipt: unknown = JSON.parse(readPrivate(path))
    if (validReceipt(receipt)) return receipt
  } catch {
    // Missing, partial or unreadable evidence never counts as a completed review.
  }
  throw new Error('invalid completed review receipt')
}

export function requireNewReceiptPath(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('review receipt already exists')
}

export function publishReviewReceipt(path: string, receipt: ReviewReceipt): void {
  if (!validReceipt(receipt)) throw new Error('invalid completed review receipt')
  const staged = join(dirname(path), `.review-${randomUUID()}.part`)
  const fd = openSync(staged, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, JSON.stringify(receipt) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // A completed private file becomes visible without replacing another run's receipt.
    linkSync(staged, path)
  } finally {
    rmSync(staged, { force: true })
  }
}
