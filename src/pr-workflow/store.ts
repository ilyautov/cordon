import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type PrTarget = { repo: string; number: number; headSha: string }
export type ReviewEvent = PrTarget & (
  { kind: 'diff-read'; diffSha256: string } | { kind: 'merge-proposed' }
)

const ttlMs = 60 * 60 * 1000
const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

export function validateTarget(target: PrTarget): void {
  const parts = typeof target.repo === 'string' ? target.repo.split('/') : []
  if (!repoPattern.test(target.repo) || !Number.isSafeInteger(target.number) ||
    target.number < 1 || !shaPattern.test(target.headSha) ||
    parts.some((part) => part === '.' || part === '..')) throw new Error('invalid PR target')
}

function validEvent(value: unknown): value is ReviewEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<ReviewEvent>
  try { validateTarget(event as PrTarget) } catch { return false }
  if (event.kind === 'diff-read') {
    return typeof event.diffSha256 === 'string' && digestPattern.test(event.diffSha256) &&
      Object.keys(event).length === 5
  }
  return event.kind === 'merge-proposed' && Object.keys(event).length === 4
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

export function readReviewEvents(path: string): ReviewEvent[] {
  if (!existsSync(path)) return []
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('invalid review ledger')
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
      const event: unknown = JSON.parse(line)
      if (!validEvent(event)) throw new Error('invalid review event')
      return event
    })
  } catch {
    throw new Error('invalid review ledger')
  }
}

function privateRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('approval directory must be private')
}

function approvalPath(root: string, target: PrTarget): string {
  validateTarget(target)
  const id = createHash('sha256').update(JSON.stringify(target)).digest('hex')
  return join(root, `${id}.json`)
}

export function approveHead(root: string, target: PrTarget, now = Date.now()): void {
  privateRoot(root)
  writeFileSync(approvalPath(root, target), JSON.stringify({ ...target, approvedAt: now }), {
    mode: 0o600, flag: 'wx',
  })
}

export function approvalFor(root: string, target: PrTarget, now = Date.now()): PrTarget | null {
  privateRoot(root)
  const path = approvalPath(root, target)
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('invalid approval record')
  let record: PrTarget & { approvedAt: number }
  try { record = JSON.parse(readFileSync(path, 'utf8')) as typeof record }
  catch { throw new Error('invalid approval record') }
  if (record.repo !== target.repo || record.number !== target.number ||
    record.headSha !== target.headSha || !Number.isSafeInteger(record.approvedAt)) {
    throw new Error('invalid approval record')
  }
  if (now < record.approvedAt || now - record.approvedAt > ttlMs) return null
  return target
}

export function consumeApproval(root: string, target: PrTarget, now = Date.now()): boolean {
  privateRoot(root)
  const source = approvalPath(root, target)
  if (!existsSync(source)) return false
  const claimed = join(root, `${randomUUID()}.spent`)
  try { renameSync(source, claimed) }
  catch (error) {
    if (!existsSync(source)) return false
    throw error
  }
  try {
    const stat = lstatSync(claimed)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('invalid approval record')
    const record = JSON.parse(readFileSync(claimed, 'utf8')) as PrTarget & { approvedAt: number }
    return record.repo === target.repo && record.number === target.number &&
      record.headSha === target.headSha && Number.isSafeInteger(record.approvedAt) &&
      now >= record.approvedAt && now - record.approvedAt <= ttlMs
  } finally {
    unlinkSync(claimed)
  }
}
