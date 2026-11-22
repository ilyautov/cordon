import { createPrivateKey, sign } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { sameSnapshot, validateTarget, type PrTarget } from './store.js'

export type MergeAppOptions = { fetch?: typeof globalThis.fetch; now?: () => number }
export type MergeAppWriter = { merge(expected: PrTarget): Promise<string> }

const apiOrigin = 'https://api.github.com'
const apiVersion = '2026-03-10'
const keyLimit = 64 * 1024
const responseLimit = 512 * 1024
const requestTimeoutMs = 15_000
const shaPattern = /^[a-f0-9]{40}$/u
const bearerPattern = /^[A-Za-z0-9._~+\/-]+={0,2}$/u
const permissions = { contents: 'write', pull_requests: 'read' }
const mergeRefusals = new Set([403, 405, 409, 422])
const unconfirmedMerge = 'GitHub merge outcome is unconfirmed. Check the PR state before any further action'

class GitHubStatusError extends Error {
  constructor(readonly status: number) {
    super('unexpected GitHub API status')
  }
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function signedJwt(keyFile: string, appId: number, now: number): string {
  let fd: number | undefined
  let pem: Buffer | undefined
  try {
    fd = openSync(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    const uid = process.getuid?.()
    if (uid === undefined || !stat.isFile() || stat.uid !== uid ||
      (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > keyLimit) {
      throw new Error('restricted owner key file required')
    }

    pem = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < pem.length) {
      const bytes = readSync(fd, pem, offset, pem.length - offset, null)
      if (bytes === 0) throw new Error('incomplete key file')
      offset += bytes
    }
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'rsa') throw new Error('RSA key required')
    const seconds = Math.floor(now / 1000)
    if (!Number.isSafeInteger(seconds) || seconds < 60) throw new Error('invalid local clock')
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iss: String(appId), iat: seconds - 60, exp: seconds + 300 }))
      .toString('base64url')
    const message = `${header}.${claims}`
    return `${message}.${sign('RSA-SHA256', Buffer.from(message), key).toString('base64url')}`
  } catch {
    // OpenSSL and filesystem errors can include details from private input.
    throw new Error('could not sign with the restricted GitHub App private key')
  } finally {
    pem?.fill(0)
    if (fd !== undefined) closeSync(fd)
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing API response')
  try {
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > responseLimit) throw new Error('oversized API response')
      chunks.push(next.value)
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const parsed = record(JSON.parse(decoder.decode(Buffer.concat(chunks, bytes))))
    if (parsed === undefined) throw new Error('invalid API response')
    return parsed
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function apiRequest(fetch: typeof globalThis.fetch) {
  return async (
    method: 'GET' | 'POST' | 'PUT', path: string, credential: string, status: number, body?: object,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(apiOrigin + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${credential}`,
        'X-GitHub-Api-Version': apiVersion,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (response.status !== status || response.redirected) {
      void response.body?.cancel().catch(() => {})
      if (response.redirected) throw new Error('unexpected GitHub API redirect')
      throw new GitHubStatusError(response.status)
    }
    return readJson(response)
  }
}

function tokenPermissions(value: unknown): boolean {
  const reported = record(value)
  return reported !== undefined && reported['contents'] === 'write' && reported['pull_requests'] === 'read' &&
    Object.keys(reported).every((key) =>
      key === 'contents' || key === 'pull_requests' || (key === 'metadata' && reported[key] === 'read'))
}

function tokenRepository(value: unknown, repositoryId: number, repo: string): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false
  const reported = record(value[0])
  return reported?.['id'] === repositoryId &&
    (!Object.hasOwn(reported, 'full_name') ||
      (typeof reported['full_name'] === 'string' && reported['full_name'].toLowerCase() === repo.toLowerCase()))
}

/**
 * Bind an installation credential to one approved PR snapshot. GitHub's
 * synchronous endpoint pins the head. The resulting parents are evidence
 * about the base after the operation, never a base precondition.
 */
export async function openMergeApp(
  target: PrTarget, repositoryId: number, appId: number, keyFile: string, options: MergeAppOptions = {},
): Promise<MergeAppWriter> {
  validateTarget(target)
  if (!positiveId(repositoryId) || !positiveId(appId)) throw new Error('invalid GitHub App or repository ID')
  const snapshot = { ...target }
  const now = options.now ?? Date.now
  const jwt = signedJwt(keyFile, appId, now())
  const request = apiRequest(options.fetch ?? globalThis.fetch)
  const endpoint = `/repos/${snapshot.repo}`

  let installation: Record<string, unknown>
  try {
    installation = await request('GET', `${endpoint}/installation`, jwt, 200)
  } catch {
    throw new Error('could not verify the GitHub App repository installation')
  }
  const installationId = installation['id']
  if (!positiveId(installationId) || installation['app_id'] !== appId ||
    installation['repository_selection'] !== 'selected' || installation['suspended_at'] !== null) {
    throw new Error('GitHub App installation is not the pinned active selected-repositories installation')
  }

  let access: Record<string, unknown>
  try {
    access = await request('POST', `/app/installations/${installationId}/access_tokens`, jwt, 201,
      { repository_ids: [repositoryId], permissions })
  } catch {
    throw new Error('could not obtain a restricted GitHub App installation token')
  }
  const token = access['token']
  const expiresAt = typeof access['expires_at'] === 'string' ? Date.parse(access['expires_at']) : NaN
  if (typeof token !== 'string' || token.length > 8_192 || !bearerPattern.test(token) ||
    !Number.isFinite(expiresAt) || expiresAt <= now() ||
    (Object.hasOwn(access, 'repository_selection') && access['repository_selection'] !== 'selected') ||
    (Object.hasOwn(access, 'permissions') && !tokenPermissions(access['permissions'])) ||
    (Object.hasOwn(access, 'repositories') && !tokenRepository(access['repositories'], repositoryId, snapshot.repo))) {
    throw new Error('GitHub App installation token did not match the requested scope')
  }

  let attempted = false
  return {
    async merge(expected) {
      validateTarget(expected)
      if (!sameSnapshot(snapshot, expected)) throw new Error('merge target differs from the GitHub App credential snapshot')
      if (attempted) throw new Error('merge already attempted with this GitHub App writer')
      if (expiresAt <= now()) throw new Error('GitHub App installation token expired before merge')
      // Even a lost response can follow a completed merge. Never resend this PUT.
      attempted = true
      let result: Record<string, unknown>
      try {
        result = await request('PUT', `${endpoint}/pulls/${snapshot.number}/merge`, token, 200,
          { sha: snapshot.headSha, merge_method: 'merge' })
      } catch (error) {
        if (error instanceof GitHubStatusError && mergeRefusals.has(error.status)) {
          throw new Error(`GitHub refused merge (HTTP ${error.status})`)
        }
        throw new Error(unconfirmedMerge)
      }
      const sha = result['sha']
      if (result['merged'] !== true || typeof sha !== 'string' || !shaPattern.test(sha)) {
        throw new Error(unconfirmedMerge)
      }

      try {
        const commit = await request('GET', `${endpoint}/git/commits/${sha}`, token, 200)
        const parents = commit['parents']
        if (commit['sha'] !== sha || !Array.isArray(parents) || parents.length !== 2 ||
          record(parents[0])?.['sha'] !== snapshot.baseSha || record(parents[1])?.['sha'] !== snapshot.headSha) {
          throw new Error('unexpected merge commit parents')
        }
      } catch {
        throw new Error('GitHub reported success, but the merge commit parents could not be verified')
      }
      return sha
    },
  }
}
