import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateTarget, type PrTarget } from './store.js'

export type TrustedCiApi = (endpoint: string, accept: string) => Buffer
export type TrustedCiConfig = { workflowId: number; workflowSha: string; workflowRef: string; runAttempt: number }
export type CiIdentity = {
  workflowId: number
  workflowSha: string
  runId: number
  runAttempt: number
  artifactId: number
  artifactDigest: string
}

const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const prefixedDigestPattern = /^sha256:[a-f0-9]{64}$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const jsonMedia = 'application/vnd.github+json'
const maxApiBytes = 1024 * 1024
const maxArchiveBytes = 16 * 1024
const maxEvidenceBytes = 4 * 1024
const evidenceFile = 'quality-evidence.json'
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function readGitHub(endpoint: string, accept: string): Buffer {
  try {
    return execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', `Accept: ${accept}`, endpoint], {
      timeout: 15_000, maxBuffer: maxApiBytes, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('GitHub CI evidence read failed')
  }
}

function parseJson(bytes: Buffer, cap: number, error: string): Record<string, unknown> {
  if (bytes.length > 0 && bytes.length <= cap) {
    try {
      const parsed = object(JSON.parse(decoder.decode(bytes)))
      if (parsed !== undefined) return parsed
    } catch {
      // Rejected responses can contain private content. Keep it out of errors.
    }
  }
  throw new Error(error)
}

function workflowRepository(
  run: Record<string, unknown>, repo: string, runId: number, config: TrustedCiConfig,
): number {
  const repository = object(run['repository'])
  const headRepository = object(run['head_repository'])
  const repositoryId = repository?.['id']
  if (run['id'] !== runId || run['workflow_id'] !== config.workflowId ||
    run['head_sha'] !== config.workflowSha || run['head_branch'] !== config.workflowRef ||
    run['run_attempt'] !== config.runAttempt || run['event'] !== 'workflow_dispatch' ||
    run['status'] !== 'completed' || run['conclusion'] !== 'success' ||
    !positiveId(repositoryId) || headRepository?.['id'] !== repositoryId ||
    typeof repository?.['full_name'] !== 'string' || repository['full_name'].toLowerCase() !== repo.toLowerCase() ||
    typeof headRepository['full_name'] !== 'string' || headRepository['full_name'].toLowerCase() !== repo.toLowerCase()) {
    throw new Error('GitHub workflow run does not match the trusted successful attempt')
  }
  return repositoryId
}

function readEvidenceArchive(archive: Buffer): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'cordon-ci-evidence-'))
  try {
    const path = join(directory, 'artifact.zip')
    writeFileSync(path, archive, { mode: 0o600, flag: 'wx' })
    const entries = execFileSync('unzip', ['-Z1', path], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: maxEvidenceBytes, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (entries !== evidenceFile + '\n') throw new Error('unexpected archive entries')
    // Stream the sole member; never let the archive choose a filesystem path.
    const record = execFileSync('unzip', ['-p', path, evidenceFile], {
      timeout: 5_000, maxBuffer: maxEvidenceBytes, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return parseJson(record, maxEvidenceBytes, 'invalid CI evidence record')
  } catch {
    throw new Error('invalid CI evidence archive or record')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Accept only the latest successful attempt of the owner-pinned workflow. */
export function readTrustedCi(
  receipt: PrTarget & { diffSha256: string },
  runId: number,
  config: TrustedCiConfig,
  read: TrustedCiApi = readGitHub,
): CiIdentity {
  validateTarget(receipt)
  const { workflowId, workflowSha, workflowRef, runAttempt } = config
  if (!positiveId(runId) || !positiveId(workflowId) || !positiveId(runAttempt) ||
    typeof workflowSha !== 'string' || !shaPattern.test(workflowSha) ||
    typeof workflowRef !== 'string' || !branchPattern.test(workflowRef) ||
    typeof receipt.diffSha256 !== 'string' || !digestPattern.test(receipt.diffSha256)) {
    throw new Error('invalid trusted CI selection')
  }

  const runPath = `repos/${receipt.repo}/actions/runs/${runId}`
  const readRun = (): number => workflowRepository(
    parseJson(read(runPath, jsonMedia), maxApiBytes, 'invalid GitHub workflow run'),
    receipt.repo, runId, config,
  )
  const repositoryId = readRun()
  const name = `cordon-pr-quality-${runId}-${runAttempt}`
  const list = parseJson(read(`${runPath}/artifacts?name=${name}&per_page=2`, jsonMedia), maxApiBytes,
    'invalid GitHub workflow artifact listing')
  if (list['total_count'] !== 1 || !Array.isArray(list['artifacts']) || list['artifacts'].length !== 1) {
    throw new Error('expected exactly one artifact for the trusted CI attempt')
  }
  const artifact = object(list['artifacts'][0])
  const artifactId = artifact?.['id']
  const artifactDigest = artifact?.['digest']
  const size = artifact?.['size_in_bytes']
  const owner = object(artifact?.['workflow_run'])
  if (!positiveId(artifactId) || artifact?.['name'] !== name || artifact['expired'] !== false ||
    typeof artifactDigest !== 'string' || !prefixedDigestPattern.test(artifactDigest) ||
    !positiveId(size) || size > maxArchiveBytes || owner?.['id'] !== runId ||
    owner['repository_id'] !== repositoryId || owner['head_repository_id'] !== repositoryId ||
    owner['head_branch'] !== workflowRef || owner['head_sha'] !== workflowSha) {
    throw new Error('invalid GitHub artifact metadata for the trusted CI attempt')
  }

  // GitHub authenticates the redirect through its REST endpoint. The target serves the ZIP bytes.
  const archive = read(`repos/${receipt.repo}/actions/artifacts/${artifactId}/zip`, jsonMedia)
  if (archive.length !== size || `sha256:${createHash('sha256').update(archive).digest('hex')}` !== artifactDigest) {
    throw new Error('CI artifact bytes do not match the GitHub artifact digest')
  }
  const evidence = readEvidenceArchive(archive)
  const { repo, number, headSha, baseRef, baseSha, diffSha256 } = receipt
  const expected = { kind: 'cordon-pr-quality-v1', repo, number, headSha, baseRef, baseSha,
    diffSha256, workflowSha, workflowRef, runId, runAttempt }
  if (Object.keys(evidence).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => key === 'repo'
      ? typeof evidence[key] !== 'string' || evidence[key].toLowerCase() !== repo.toLowerCase()
      : evidence[key] !== value)) {
    throw new Error('CI evidence does not attest to the selected PR snapshot and diff')
  }

  // Reject a newer rerun that superseded this attempt during the artifact read.
  if (readRun() !== repositoryId) throw new Error('GitHub workflow run repository changed')
  return { workflowId, workflowSha, runId, runAttempt, artifactId, artifactDigest }
}
