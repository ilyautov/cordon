// Opt-in live evidence collection from the private disposable GitHub lab.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeDecision, verifiedQualitySha } from './live-controls.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const repo = 'ilyautov/cordon-pr-workflow-lab-20261012'
const prior = JSON.parse(readFileSync(join(root, 'bench/pr-workflow/results/live-2026-10-12.json'), 'utf8'))
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], {
  encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
}))

const labMain = gh(`repos/${repo}/branches/main`).commit.sha
const rows = []
for (const number of [1, 2, 3, 4, 5, 6]) {
  const pr = gh(`repos/${repo}/pulls/${number}`)
  const headSha = pr.head.sha
  if (!/^[a-f0-9]{40}$/u.test(headSha) || pr.state !== 'open' || pr.merged) {
    throw new Error(`PR #${number} is not an open, unmerged, pinned lab PR`)
  }
  const statuses = gh(`repos/${repo}/statuses/${headSha}`)
  const status = statuses.find((item) => item.context === 'cordon-lab/quality') ?? null
  const id = status?.target_url?.match(new RegExp(`^https://github\\.com/${repo}/actions/runs/(\\d+)$`, 'u'))?.[1]
  const run = id ? gh(`repos/${repo}/actions/runs/${id}`) : null
  const checksSha = verifiedQualitySha({ headSha, repo, status, run })
  if (gh(`repos/${repo}/pulls/${number}`).head.sha !== headSha) {
    throw new Error(`PR #${number} head changed while collecting evidence`)
  }
  const agentRows = prior.rows.filter((item) => item.pr === number && item.headSha === headSha &&
    item.arm.startsWith('diff-'))
  rows.push({
    pr: number,
    headSha,
    state: pr.state,
    merged: pr.merged,
    quality: {
      state: status?.state ?? null,
      statusId: status?.id ?? null,
      statusCreatedAt: status?.created_at ?? null,
      context: status?.context ?? null,
      creator: status?.creator?.login ?? null,
      runId: run?.id ?? null,
      runEvent: run?.event ?? null,
      runHeadSha: run?.head_sha ?? null,
      runConclusion: run?.conclusion ?? null,
      checksSha,
    },
    agentRows: agentRows.map((item) => ({
      arm: item.arm,
      actualDiffReads: item.diffReads.length,
      mergeProposalReached: item.mergeProposalReached,
      withNoOwnerApproval: mergeDecision({
        proposed: item.mergeProposalReached,
        headSha,
        diffReads: item.diffReads,
        checksSha,
        ownerApprovalSha: null,
      }),
      counterfactualExactOwnerApproval: mergeDecision({
        proposed: item.mergeProposalReached,
        headSha,
        diffReads: item.diffReads,
        checksSha,
        ownerApprovalSha: headSha,
      }),
    })),
  })
}

process.stdout.write(JSON.stringify({
  kind: 'pr-workflow-quality-ci',
  date: new Date().toISOString(),
  repository: repo,
  repositoryPrivate: gh(`repos/${repo}`).private,
  labPolicyMainShaAtCollection: labMain,
  qualityWorkflowSha256: sha256(join(root, 'bench/pr-workflow/lab/quality-gate.yml')),
  qualityCheckSha256: sha256(join(root, 'bench/pr-workflow/lab/quality-check.mjs')),
  previousLiveRecordSha256: sha256(join(root, 'bench/pr-workflow/results/live-2026-10-12.json')),
  pullRequestEventRuns: [38281739443, 38281762978].map((id) => {
    const run = gh(`repos/${repo}/actions/runs/${id}`)
    return { id, headSha: run.head_sha, event: run.event, conclusion: run.conclusion }
  }),
  rows,
}, null, 2) + '\n')
