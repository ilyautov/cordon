import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { validateTarget, type PrTarget, type ReviewReceipt } from './store.js'

export type CommentRequest =
  | { method: 'GET'; endpoint: string; paginate?: boolean }
  | { method: 'POST'; endpoint: string; body: string }
type CommentApi = (request: CommentRequest) => unknown

export function fixedComment(receipt: PrTarget & { diffSha256: string }): string {
  validateTarget(receipt)
  if (!/^[a-f0-9]{64}$/u.test(receipt.diffSha256)) throw new Error('invalid reviewed diff digest')
  // Branch names are data. Escape punctuation so it cannot change the Markdown.
  const base = 'refs/heads/' + receipt.baseRef.split('/').map(encodeURIComponent).join('/')
  return [
    `Cordon recorded a review of this snapshot of PR #${receipt.number}.`,
    '',
    `- Head SHA: \`${receipt.headSha}\``,
    `- Base: \`${base}\` at \`${receipt.baseSha}\``,
    `- Diff SHA-256: \`${receipt.diffSha256}\``,
    '',
    'The PR may have changed since this review.',
  ].join('\n')
}

function github(request: CommentRequest): unknown {
  const flags = request.method === 'POST' ? ['--raw-field', 'body=' + request.body]
    : request.paginate ? ['--paginate', '--slurp'] : []
  try {
    return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--method', request.method,
      '-H', 'Accept: application/vnd.github+json', ...flags, request.endpoint], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch {
    throw new Error('GitHub comment API request failed')
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function findComment(api: CommentApi, endpoint: string, body: string, ownerId: number): number | undefined {
  const pages = api({ method: 'GET', endpoint: endpoint + '?per_page=100', paginate: true })
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('invalid GitHub comment list')
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error('invalid GitHub comment list')
    for (const value of page) {
      const comment = object(value)
      if (!positiveId(comment?.['id']) || typeof comment?.['body'] !== 'string') {
        throw new Error('invalid GitHub comment list')
      }
      if (comment['body'] !== body || comment['user'] === null) continue
      const authorId = object(comment['user'])?.['id']
      if (!positiveId(authorId)) throw new Error('invalid GitHub comment author')
      if (authorId === ownerId) return comment['id']
    }
  }
  return undefined
}

function claimPublication(root: string, key: string): boolean {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(directory)
    const uid = process.geteuid?.()
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
      throw new Error('comment state directory must be private and owner-controlled')
    }
    let fd: number
    try {
      fd = openSync(join(root, `.comment-${key}.attempted`), 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    try { fsyncSync(fd) } finally { closeSync(fd) }
    fsyncSync(directory)
    return true
  } finally {
    closeSync(directory)
  }
}

export function publishReviewComment(root: string, receipt: ReviewReceipt, api: CommentApi = github): {
  commentId: number; published: boolean
} {
  const body = fixedComment(receipt)
  const ownerId = object(api({ method: 'GET', endpoint: 'user' }))?.['id']
  if (!positiveId(ownerId)) throw new Error('could not verify the authenticated GitHub user')
  const endpoint = `repos/${receipt.repo}/issues/${receipt.number}/comments`
  const existing = findComment(api, endpoint, body, ownerId)
  if (existing !== undefined) return { commentId: existing, published: false }

  const { repo, number, headSha, baseRef, baseSha, diffSha256 } = receipt
  const key = createHash('sha256').update(JSON.stringify([
    ownerId, repo.toLowerCase(), number, headSha, baseRef, baseSha, diffSha256,
  ])).digest('hex')
  const unconfirmed = 'comment publication is unconfirmed; inspect the PR before attempting another publication'
  // Persist the intent before POST. A response can be lost after GitHub creates
  // the comment. On retry we can reconcile it by reading, never by a second POST.
  if (!claimPublication(root, key)) {
    const found = findComment(api, endpoint, body, ownerId)
    if (found !== undefined) return { commentId: found, published: false }
    throw new Error(unconfirmed)
  }

  try {
    const result = object(api({ method: 'POST', endpoint, body }))
    const commentId = result?.['id']
    if (positiveId(commentId) && result?.['body'] === body && object(result['user'])?.['id'] === ownerId) {
      return { commentId, published: true }
    }
  } catch {
    // GitHub may already have created the comment. Keep the intent for reconciliation.
  }
  throw new Error(unconfirmed)
}
