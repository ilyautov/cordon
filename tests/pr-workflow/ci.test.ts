import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTrustedCi, type TrustedCiApi } from '../../src/pr-workflow/ci.js'

const receipt = { repo: 'owner/example', number: 12, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40), diffSha256: 'c'.repeat(64) }
const config = { workflowId: 7, workflowSha: 'd'.repeat(40), workflowRef: 'trusted-ci', runAttempt: 2 }
const runId = 14
const runPath = `repos/${receipt.repo}/actions/runs/${runId}`
const artifactId = 88
const name = `cordon-pr-quality-${runId}-${config.runAttempt}`
const artifactPath = `${runPath}/artifacts?name=${name}&per_page=2`
const archivePath = `repos/${receipt.repo}/actions/artifacts/${artifactId}/zip`

function zip(record: object, extraFile = false): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'cordon-ci-test-'))
  try {
    writeFileSync(join(root, 'quality-evidence.json'), JSON.stringify(record))
    if (extraFile) writeFileSync(join(root, 'notes.txt'), 'Some notes.')
    execFileSync('zip', ['-q', 'bundle.zip', 'quality-evidence.json', ...(extraFile ? ['notes.txt'] : [])], { cwd: root })
    return readFileSync(join(root, 'bundle.zip'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const digest = (buf: Buffer) => `sha256:${createHash('sha256').update(buf).digest('hex')}`

function mock(options: {
  run?: Record<string, unknown>
  artifact?: Record<string, unknown>
  evidence?: Record<string, unknown>
  extraFile?: boolean
  nextAttempt?: number
} = {}) {
  const archive = zip({ kind: 'cordon-pr-quality-v1', ...receipt, workflowSha: config.workflowSha,
    workflowRef: config.workflowRef, runId, runAttempt: config.runAttempt, ...options.evidence }, options.extraFile)
  const repo = { full_name: receipt.repo, id: 90 }
  const run = { id: runId, run_attempt: config.runAttempt, status: 'completed', conclusion: 'success',
    event: 'workflow_dispatch', workflow_id: config.workflowId,
    head_sha: config.workflowSha, head_branch: config.workflowRef,
    repository: repo, head_repository: repo, ...options.run }
  const artifact = { id: artifactId, name, size_in_bytes: archive.length, expired: false, digest: digest(archive),
    workflow_run: { id: runId, repository_id: 90, head_repository_id: 90,
      head_branch: config.workflowRef, head_sha: config.workflowSha }, ...options.artifact }
  const paths: string[] = []
  const media: string[] = []
  let runReads = 0
  const api: TrustedCiApi = (path, accept) => {
    paths.push(path)
    media.push(accept)
    if (path === archivePath) return archive
    if (path === runPath) {
      runReads++
      return Buffer.from(JSON.stringify({ ...run, ...runReads > 1 && options.nextAttempt !== undefined
        ? { run_attempt: options.nextAttempt } : {} }))
    }
    if (path === artifactPath) return Buffer.from(JSON.stringify({ total_count: 1, artifacts: [artifact] }))
    throw new Error('unexpected mocked request')
  }
  return { api, paths, media, archive }
}

describe('trusted CI evidence', () => {
  it('requests the archive redirect using the GitHub REST media type', () => {
    const { api, media } = mock()
    readTrustedCi(receipt, runId, config, api)
    expect(media[2]).toBe('application/vnd.github+json')
  })

  it('matches GitHub repository names independently of capitalization', () => {
    const { api } = mock({ evidence: { repo: 'Owner/Example' } })
    expect(readTrustedCi(receipt, runId, config, api).artifactId).toBe(artifactId)
  })

  it('authenticates the exact run, attempt, ZIP and checked diff', () => {
    const { api, paths, archive } = mock()
    expect(readTrustedCi(receipt, runId, config, api)).toEqual({
      workflowId: config.workflowId, workflowSha: config.workflowSha, runId, runAttempt: config.runAttempt,
      artifactId, artifactDigest: digest(archive),
    })
    expect(paths).toEqual([runPath, artifactPath, archivePath, runPath])
  })

  it.each([
    { workflow_id: 8 }, { head_sha: 'e'.repeat(40) }, { head_branch: 'other' },
    { run_attempt: 1 }, { conclusion: 'cancelled' }, { event: 'push' },
    { head_repository: { id: 91, full_name: 'other/example' } },
    { repository: { id: 90, full_name: 'other/example' } },
  ])('refuses an untrusted or unsuccessful run without reading an artifact', (run) => {
    const { api, paths } = mock({ run })
    expect(() => readTrustedCi(receipt, runId, config, api)).toThrow(/workflow run/)
    expect(paths).toEqual([runPath])
  })

  it('refuses an artifact from another run independently of its name', () => {
    const { api, paths } = mock({ artifact: { workflow_run: { id: 2 } } })
    expect(() => readTrustedCi(receipt, runId, config, api)).toThrow(/artifact/)
    expect(paths).toEqual([runPath, artifactPath])
  })

  it('refuses bytes whose digest differs from authenticated artifact metadata', () => {
    const { api } = mock({ artifact: { digest: `sha256:${'1'.repeat(64)}` } })
    expect(() => readTrustedCi(receipt, runId, config, api)).toThrow(/digest/)
  })

  it('requires the archive to contain only the fixed evidence file', () => {
    const { api } = mock({ extraFile: true })
    expect(() => readTrustedCi(receipt, runId, config, api)).toThrow(/archive/)
  })

  it.each([
    { diffSha256: 'e'.repeat(64) }, { baseSha: 'e'.repeat(40) }, { baseRef: 'other' },
    { runAttempt: 1 }, { workflowRef: 'other' }, { unused: 'extra field' },
  ])('refuses evidence that does not attest to this exact diff, base and attempt', (evidence) => {
    const { api } = mock({ evidence })
    expect(() => readTrustedCi(receipt, runId, config, api)).toThrow(/evidence/)
  })

  it('does not accept an attempt that changed while the artifact was read', () => {
    const { api } = mock({ nextAttempt: 3 })
    expect(() => readTrustedCi(receipt, runId, config, api)).toThrow(/workflow run/)
  })
})
