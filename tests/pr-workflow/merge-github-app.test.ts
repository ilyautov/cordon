import { generateKeyPairSync, verify } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openMergeApp } from '../../src/pr-workflow/merge-github-app.js'

const target = { repo: 'owner/example', number: 12, headSha: 'a'.repeat(40), baseRef: 'main', baseSha: 'b'.repeat(40) }
const commitSha = 'c'.repeat(40)
const installId = 131
const repositoryId = 42
const appId = 650
const now = Date.parse('2026-11-22T12:00:00Z')
const token = 'example-installation-credential'
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = key.privateKey.export({ type: 'pkcs1', format: 'pem' })

let scratch: string
let keyFile: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cordon-merge-app-'))
  keyFile = join(scratch, 'app-key.pem')
  writeFileSync(keyFile, pem, { mode: 0o600 })
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

type Request = { url: URL; method: string; auth: string | null; body: unknown; redirect: string | undefined; signal: AbortSignal | null | undefined }

function mockedGitHub(changes: {
  installation?: object
  token?: object
  mergeStatus?: number
  merge?: object
  commit?: object
  loseMergeResponse?: boolean
  redirectInstallation?: boolean
  oversizedInstallation?: boolean
} = {}) {
  const requests: Request[] = []
  const fetch: typeof globalThis.fetch = async (path, init) => {
    const request = {
      url: new URL(String(path)), method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      redirect: init?.redirect, signal: init?.signal,
    }
    requests.push(request)
    const reply = (body: object, status: number) => new Response(JSON.stringify(body), { status })
    switch (request.url.pathname) {
      case '/repos/owner/example/installation':
        if (changes.redirectInstallation) {
          return new Response(token, { status: 302, headers: { location: 'https://example.com/elsewhere' } })
        }
        if (changes.oversizedInstallation) return new Response('x'.repeat(1024 * 1024))
        return reply({ id: installId, app_id: appId, repository_selection: 'selected', suspended_at: null,
          ...changes.installation }, 200)
      case '/app/installations/131/access_tokens':
        return reply({ token, expires_at: '2026-11-22T13:00:00Z', repository_selection: 'selected',
          permissions: { contents: 'write', pull_requests: 'read', metadata: 'read' },
          repositories: [{ id: repositoryId, full_name: target.repo }], ...changes.token }, 201)
      case '/repos/owner/example/pulls/12/merge':
        if (changes.loseMergeResponse) throw new Error(token)
        return reply({ sha: commitSha, merged: true, ...changes.merge }, changes.mergeStatus ?? 200)
      case `/repos/owner/example/git/commits/${commitSha}`:
        return reply({ sha: commitSha, parents: [{ sha: target.baseSha }, { sha: target.headSha }], ...changes.commit }, 200)
      default:
        throw new Error('unexpected mocked API path')
    }
  }
  return { fetch, requests, now: () => now }
}

describe('GitHub App merge writer', () => {
  it('signs a short GitHub App JWT and obtains an exact repository-scoped token', async () => {
    const mock = mockedGitHub()
    const writer = await openMergeApp(target, repositoryId, appId, keyFile, mock)
    expect(await writer.merge(target)).toBe(commitSha)
    const [install, exchange, merge, commit] = mock.requests
    expect(mock.requests.map(({ method, url }) => [method, url.pathname])).toEqual([
      ['GET', '/repos/owner/example/installation'], ['POST', '/app/installations/131/access_tokens'],
      ['PUT', '/repos/owner/example/pulls/12/merge'], ['GET', `/repos/owner/example/git/commits/${commitSha}`],
    ])
    expect(mock.requests.every((request) => request.url.origin === 'https://api.github.com' &&
      request.redirect === 'error' && request.signal instanceof AbortSignal)).toBe(true)
    const jwt = install?.auth?.slice('Bearer '.length)
    expect(install?.auth).toMatch(/^Bearer /u)
    expect(exchange?.auth).toBe(install?.auth)
    const [header, payload, signature] = jwt!.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({ alg: 'RS256' })
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      iss: String(appId), iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 300,
    })
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
    expect(exchange?.body).toEqual({ repository_ids: [repositoryId],
      permissions: { contents: 'write', pull_requests: 'read' } })
    expect(merge?.auth).toBe(`Bearer ${token}`)
    expect(commit?.auth).toBe(`Bearer ${token}`)
    expect(merge?.body).toEqual({ sha: target.headSha, merge_method: 'merge' })
  })

  it.each([{ app_id: appId + 1 }, { repository_selection: 'all' }, { suspended_at: '2026-11-22T10:12:00Z' }])(
    'refuses a GitHub App installation that is not the selected active App', async (installation) => {
      const mock = mockedGitHub({ installation })
      await expect(openMergeApp(target, repositoryId, appId, keyFile, mock)).rejects.toThrow(/installation/)
      expect(mock.requests).toHaveLength(1)
    })

  it.each([
    { permissions: { contents: 'write', pull_requests: 'write' } },
    { permissions: { contents: 'write', pull_requests: 'read', actions: 'read' } },
    { repository_selection: 'all' },
    { repositories: [{ id: repositoryId + 1, full_name: target.repo }] },
    { repositories: [{ id: repositoryId, full_name: 'owner/renamed' }] },
    { expires_at: '2026-11-22T11:59:59Z' },
  ])('refuses an installation token outside the requested limits', async (tokenFields) => {
    const mock = mockedGitHub({ token: tokenFields })
    await expect(openMergeApp(target, repositoryId, appId, keyFile, mock)).rejects.toThrow(/token/)
    expect(mock.requests).toHaveLength(2)
  })

  it('rejects shared, symlinked and non-regular key files before making any API request', async () => {
    const mock = mockedGitHub()
    chmodSync(keyFile, 0o640)
    await expect(openMergeApp(target, repositoryId, appId, keyFile, mock)).rejects.toThrow(/key/)
    chmodSync(keyFile, 0o600)
    const link = join(scratch, 'link.pem')
    symlinkSync(keyFile, link)
    await expect(openMergeApp(target, repositoryId, appId, link, mock)).rejects.toThrow(/key/)
    await expect(openMergeApp(target, repositoryId, appId, scratch, mock)).rejects.toThrow(/key/)
    expect(mock.requests).toHaveLength(0)
  })

  it.each([{ redirectInstallation: true }, { oversizedInstallation: true }])(
    'fails closed on unusable API responses before minting a token', async (options) => {
      const mock = mockedGitHub(options)
      await expect(openMergeApp(target, repositoryId, appId, keyFile, mock)).rejects.toThrow(/installation/)
      expect(mock.requests).toHaveLength(1)
    })

  it('binds the writer to its original snapshot even if its caller changes the object', async () => {
    const mock = mockedGitHub()
    const mutable = { ...target }
    const writer = await openMergeApp(mutable, repositoryId, appId, keyFile, mock)
    mutable.baseSha = 'd'.repeat(40)
    await expect(writer.merge(mutable)).rejects.toThrow(/snapshot/)
    expect(mock.requests).toHaveLength(2)
    expect(await writer.merge(target)).toBe(commitSha)
  })

  it('never retries an uncertain merge and keeps credential text out of errors', async () => {
    const mock = mockedGitHub({ loseMergeResponse: true })
    const writer = await openMergeApp(target, repositoryId, appId, keyFile, mock)
    await expect(writer.merge(target)).rejects.toThrow(/outcome.*unconfirmed/)
    await expect(writer.merge(target)).rejects.toThrow(/attempted/)
    expect(mock.requests).toHaveLength(3)
  })

  it.each([403, 405, 409, 422])('reports HTTP %i as a refusal without repeating the request or exposing its body', async (mergeStatus) => {
    const mock = mockedGitHub({ mergeStatus, merge: { message: 'Private response details' } })
    const writer = await openMergeApp(target, repositoryId, appId, keyFile, mock)
    await expect(writer.merge(target)).rejects.toHaveProperty('message', `GitHub refused merge (HTTP ${mergeStatus})`)
    await expect(writer.merge(target)).rejects.toThrow(/attempted/)
    expect(mock.requests).toHaveLength(3)
  })

  it('keeps an unexpected server error unconfirmed', async () => {
    const mock = mockedGitHub({ mergeStatus: 500 })
    const writer = await openMergeApp(target, repositoryId, appId, keyFile, mock)
    await expect(writer.merge(target)).rejects.toThrow(/outcome.*unconfirmed/)
    await expect(writer.merge(target)).rejects.toThrow(/attempted/)
    expect(mock.requests).toHaveLength(3)
  })

  it('does not treat an accepted asynchronous result as a successful merge', async () => {
    const mock = mockedGitHub({ mergeStatus: 202 })
    const writer = await openMergeApp(target, repositoryId, appId, keyFile, mock)
    await expect(writer.merge(target)).rejects.toThrow(/outcome.*unconfirmed/)
    expect(mock.requests).toHaveLength(3)
  })

  it.each([
    [{ sha: target.baseSha }], [{ sha: target.headSha }, { sha: target.baseSha }],
    [{ sha: target.baseSha }, { sha: 'd'.repeat(40) }],
    [{ sha: target.baseSha }, { sha: target.headSha }, { sha: 'd'.repeat(40) }],
  ])('reports a GitHub merge success with unverified parents distinctly', async (...parents) => {
    const mock = mockedGitHub({ commit: { parents } })
    const writer = await openMergeApp(target, repositoryId, appId, keyFile, mock)
    await expect(writer.merge(target)).rejects.toThrow(/reported success.*parents/)
    expect(mock.requests).toHaveLength(4)
  })
})
