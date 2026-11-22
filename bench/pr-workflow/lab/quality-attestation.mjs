// Copy this file, quality-check.mjs, and built github.js/store.js into the
// trusted lab workflow directory. No PR file is checked out or executed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPinnedDiff, getPullSnapshot } from './github.js'
import { sameSnapshot, validateTarget } from './store.js'
import { assessLabCandidate } from './quality-check.mjs'

const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u
const file = 'login.html'

function readJson(path) {
  try {
    return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json', path], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch {
    throw new Error('could not read lab data from GitHub')
  }
}

function readPage(repo, headSha) {
  const commit = readJson(`repos/${repo}/git/commits/${headSha}`)
  if (commit.sha !== headSha || !shaPattern.test(commit.tree?.sha ?? '')) {
    throw new Error('GitHub returned a different commit')
  }
  const tree = readJson(`repos/${repo}/git/trees/${commit.tree.sha}`)
  if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error('GitHub returned an incomplete commit tree')
  }
  const entry = tree.tree.find((item) => item.path === file)
  if (entry?.type !== 'blob' || entry.mode !== '100644' || !shaPattern.test(entry.sha) ||
    !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 65_536) {
    throw new Error('lab page must be a small regular blob')
  }
  const blob = readJson(`repos/${repo}/git/blobs/${entry.sha}`)
  if (blob.sha !== entry.sha || blob.encoding !== 'base64' ||
    typeof blob.content !== 'string' || blob.size !== entry.size) {
    throw new Error('GitHub returned an unexpected lab blob')
  }
  const bytes = Buffer.from(blob.content, 'base64')
  if (bytes.length !== entry.size) throw new Error('GitHub returned an incomplete lab blob')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function main() {
  const { GITHUB_REPOSITORY: repo, GITHUB_WORKFLOW_SHA: workflowSha, GITHUB_REF_NAME: workflowRef,
    GITHUB_SHA: runHead, GITHUB_REF_TYPE: refType, GITHUB_EVENT_NAME: event,
    GITHUB_RUN_ID: idText, GITHUB_RUN_ATTEMPT: attemptText, RUNNER_TEMP: outputDir,
  } = process.env
  const runId = Number(idText)
  const runAttempt = Number(attemptText)
  if (event !== 'workflow_dispatch' || refType !== 'branch' || !branchPattern.test(workflowRef ?? '') ||
    !shaPattern.test(workflowSha ?? '') || runHead !== workflowSha || !outputDir ||
    !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new Error('lab check needs a trusted branch dispatch')
  }

  const target = { repo, number: Number(process.env.PR_NUMBER), headSha: process.env.PR_HEAD_SHA,
    baseRef: process.env.PR_BASE_REF, baseSha: process.env.PR_BASE_SHA }
  validateTarget(target)
  const before = getPullSnapshot(repo, target.number)
  if (!sameSnapshot(before, target)) throw new Error('selected PR changed before the quality check')
  const diff = getPinnedDiff(target)
  const diffSha256 = createHash('sha256').update(diff, 'utf8').digest('hex')
  const expectedDigest = process.env.PR_DIFF_SHA256
  if (!digestPattern.test(expectedDigest ?? '') || diffSha256 !== expectedDigest) {
    throw new Error('quality check received a different diff from the review receipt')
  }

  // getPinnedDiff already validated the complete text diff against GitHub's
  // change list. This particular lab policy accepts exactly one known path.
  const headers = diff.match(/^diff --git .+$/gmu) ?? []
  if (headers.length !== 1 || headers[0] !== `diff --git a/${file} b/${file}`) {
    throw new Error('lab quality check expects a change to login.html only')
  }
  const html = readPage(repo, target.headSha)
  const after = getPullSnapshot(repo, target.number)
  if (!sameSnapshot(after, target)) throw new Error('selected PR changed during the quality check')
  const verdict = assessLabCandidate({ expectedSha: target.headSha, checkoutSha: target.headSha,
    currentSha: after.headSha, changedPaths: [file], regularFile: true, html })
  if (!verdict.allow) throw new Error(`lab quality check refused: ${verdict.reason}`)

  writeFileSync(join(outputDir, 'quality-evidence.json'), JSON.stringify({
    kind: 'cordon-pr-quality-v1', ...target, diffSha256, workflowSha, workflowRef, runId, runAttempt,
  }) + '\n', { mode: 0o600, flag: 'wx' })
}

try {
  main()
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'lab quality check failed') + '\n')
  process.exitCode = 1
}
