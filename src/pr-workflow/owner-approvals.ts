import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { CiIdentity } from './ci.js'
export type { CiIdentity } from './ci.js'
import { validateTarget, type ReviewReceipt } from './store.js'

export type ApprovalTarget = Pick<ReviewReceipt, 'repo' | 'number' | 'headSha' | 'baseRef' | 'baseSha' |
  'runId' | 'diffSha256'>
type Binding = ApprovalTarget & { ci: CiIdentity }
export type ApprovalRecord = Binding & { generation: string; approvedAt: number }

type GenerationFile = { path: string; slot: number; record: ApprovalRecord; stat: BigIntStats }

const ttlMs = 60 * 60 * 1_000
const sha = /^[a-f0-9]{40}$/u
const digest = /^[a-f0-9]{64}$/u
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

export function sameReview(left: ApprovalTarget, right: ApprovalTarget): boolean {
  return left.repo === right.repo && left.number === right.number && left.headSha === right.headSha &&
    left.baseRef === right.baseRef && left.baseSha === right.baseSha &&
    left.runId === right.runId && left.diffSha256 === right.diffSha256
}

export function sameCiIdentity(left: CiIdentity, right: CiIdentity): boolean {
  return left.workflowId === right.workflowId && left.workflowSha === right.workflowSha &&
    left.runId === right.runId && left.runAttempt === right.runAttempt &&
    left.artifactId === right.artifactId && left.artifactDigest === right.artifactDigest
}

function sameGeneration(left: ApprovalRecord, right: ApprovalRecord): boolean {
  return sameReview(left, right) && sameCiIdentity(left.ci, right.ci) &&
    left.generation === right.generation && left.approvedAt === right.approvedAt
}

function bindingFor(receipt: ReviewReceipt, ci: CiIdentity): Binding {
  validateTarget(receipt)
  const { repo, number, headSha, baseRef, baseSha, runId, diffSha256 } = receipt
  if (receipt.kind !== 'review-completed' || typeof runId !== 'string' || !uuid.test(runId) ||
    typeof diffSha256 !== 'string' || !digest.test(diffSha256)) {
    throw new Error('invalid completed review receipt')
  }
  const { workflowId, workflowSha, runId: ciRun, runAttempt, artifactId, artifactDigest } = ci
  if (![workflowId, ciRun, runAttempt, artifactId].every((id) => Number.isSafeInteger(id) && id > 0) ||
    typeof workflowSha !== 'string' || !sha.test(workflowSha) || typeof artifactDigest !== 'string' ||
    !/^(?:sha256:)?[a-f0-9]{64}$/u.test(artifactDigest)) {
    throw new Error('invalid CI proof identity')
  }
  return { repo, number, headSha, baseRef, baseSha, runId, diffSha256,
    ci: { workflowId, workflowSha, runId: ciRun, runAttempt, artifactId, artifactDigest } }
}

function errno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function privateMode(stat: BigIntStats): boolean {
  const uid = process.geteuid?.()
  return (stat.mode & 0o077n) === 0n && (uid === undefined || stat.uid === BigInt(uid))
}

function withPrivateRoot<T>(root: string, create: boolean, visit: (fd: number) => T): T | null {
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 })
  let fd: number
  try { fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY) }
  catch (error) {
    if (!create && errno(error, 'ENOENT')) return null
    throw error
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isDirectory() || !privateMode(stat)) throw new Error('approval directory must be private')
    return visit(fd)
  } finally {
    closeSync(fd)
  }
}

function readRecord(fd: number, binding: Binding): ApprovalRecord {
  let record: ApprovalRecord
  try { record = JSON.parse(readFileSync(fd, 'utf8')) }
  catch {
    // A damaged generation is never a reason to issue or consume another.
    throw new Error('invalid approval record')
  }
  if (record === null || !sameReview(record, binding) || !record.ci || !sameCiIdentity(record.ci, binding.ci) ||
    typeof record.generation !== 'string' || !uuid.test(record.generation) ||
    !Number.isSafeInteger(record.approvedAt) || record.approvedAt < 0 || Object.keys(record).length !== 10) {
    throw new Error('invalid approval record')
  }
  return record
}

function withLatest<T>(root: string, binding: Binding, visit: (current: GenerationFile | null, prefix: string) => T): T {
  const prefix = createHash('sha256').update(JSON.stringify(binding)).digest('hex')
  // Closed slots stay in the private store, so every generation gets a new
  // path and a process that already opened an old slot cannot consume its replacement.
  let slot = 0
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix + '.')) continue
    const match = /^([1-9][0-9]*)\.json$/u.exec(name.slice(prefix.length + 1))
    if (!match) continue
    const candidate = Number(match[1])
    if (!Number.isSafeInteger(candidate)) throw new Error('invalid approval generation slot')
    slot = Math.max(slot, candidate)
  }
  if (slot === 0) return visit(null, prefix)
  const path = join(root, `${prefix}.${slot}.json`)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || !privateMode(stat) || stat.size > 16_384n) {
      throw new Error('invalid approval record')
    }
    // Keep the inode live through the atomic claim, so it cannot be recycled
    // if the source path is removed before the hardlink.
    return visit({ path, slot, record: readRecord(fd, binding), stat }, prefix)
  } finally {
    closeSync(fd)
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && privateMode(left) && left.dev === right.dev && left.ino === right.ino
}

function isClosed(current: GenerationFile): boolean {
  let marker: BigIntStats
  try { marker = lstatSync(current.path + '.closed', { bigint: true }) }
  catch (error) {
    if (errno(error, 'ENOENT')) return false
    throw error
  }
  if (!sameFile(marker, current.stat)) throw new Error('invalid approval closure')
  return true
}

function closeGeneration(current: GenerationFile, dir: number): boolean {
  try { linkSync(current.path, current.path + '.closed') }
  catch (error) {
    if (errno(error, 'EEXIST') && isClosed(current)) return false
    throw error
  }
  if (!isClosed(current) || !sameFile(lstatSync(current.path, { bigint: true }), current.stat)) {
    throw new Error('approval record changed before claim')
  }
  fsyncSync(dir)
  return true
}

function publish(root: string, path: string, record: ApprovalRecord, dir: number): void {
  const stage = join(root, `.approval-${record.generation}.part`)
  const fd = openSync(stage, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(record) + '\n')
    fsyncSync(fd)
    const stat = fstatSync(fd, { bigint: true })
    try { linkSync(stage, path) }
    catch (error) {
      if (errno(error, 'EEXIST')) throw new Error('approval already active or changed')
      throw error
    }
    if (!sameFile(lstatSync(path, { bigint: true }), stat)) throw new Error('approval record changed before publication')
    fsyncSync(dir)
  } finally {
    closeSync(fd)
    rmSync(stage, { force: true })
  }
}

function validTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid approval timestamp')
}

function isCurrent(current: GenerationFile, now: number): boolean {
  return now >= current.record.approvedAt && now - current.record.approvedAt <= ttlMs && !isClosed(current)
}

export function approveReceipt(root: string, receipt: ReviewReceipt, ci: CiIdentity, now = Date.now()): ApprovalRecord {
  if (receipt.mergeProposed !== true) throw new Error('the review did not propose merge')
  const binding = bindingFor(receipt, ci)
  validTime(now)
  return withPrivateRoot(root, true, (dir) => withLatest(root, binding, (current, prefix) => {
    if (current && !isClosed(current)) {
      if (now - current.record.approvedAt <= ttlMs) throw new Error('approval already active')
      // Expiry and consumption compete for the same terminal marker. Once
      // this exists, a holder of the previous generation can no longer claim it.
      closeGeneration(current, dir)
    }
    const slot = (current?.slot ?? 0) + 1
    if (!Number.isSafeInteger(slot)) throw new Error('approval generation slots exhausted')
    const record = { ...binding, generation: randomUUID(), approvedAt: now }
    publish(root, join(root, `${prefix}.${slot}.json`), record, dir)
    return record
  }))!
}

export function approvalForReceipt(root: string, receipt: ReviewReceipt, ci: CiIdentity,
  now = Date.now()): ApprovalRecord | null {
  if (receipt.mergeProposed !== true) return null
  const binding = bindingFor(receipt, ci)
  validTime(now)
  return withPrivateRoot(root, false, () => withLatest(root, binding, (current) =>
    current && isCurrent(current, now) ? current.record : null))
}

export function consumeReceiptApproval(root: string, receipt: ReviewReceipt, ci: CiIdentity, expected: ApprovalRecord,
  now = Date.now()): boolean {
  if (receipt.mergeProposed !== true) return false
  const binding = bindingFor(receipt, ci)
  validTime(now)
  return withPrivateRoot(root, false, (dir) => withLatest(root, binding, (current) => {
    if (!current || !expected || !expected.ci || !sameGeneration(current.record, expected) || !isCurrent(current, now)) {
      return false
    }
    return closeGeneration(current, dir)
  })) ?? false
}
