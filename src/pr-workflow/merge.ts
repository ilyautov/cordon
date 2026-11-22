import { sameReview, type ApprovalTarget } from './owner-approvals.js'
import type { ReviewReceipt } from './store.js'

type Status = { context: string; state: string; creator: { login: string }; target_url: string }
type Run = { id: number; name: string; conclusion: string; event: string; head_sha: string;
  head_branch: string; workflow_id: number; repository: { full_name: string } }
type Facts = { repo: string; number: number; headSha: string; receipt: ReviewReceipt | null;
  status: Status | null; run: Run | null; approval: ApprovalTarget | null;
  trustedWorkflowId: number; trustedContext: string }
type Decision = { allow: boolean; reason: string }

const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

function hasExpectedWorkflowReference(repo: string, sha: string, status: Status | null, run: Run | null,
  trustedWorkflowId: number, trustedContext: string): boolean {
  if (!repoPattern.test(repo) || repo.split('/').some((part) => part === '.' || part === '..') ||
    !shaPattern.test(sha) || !run || !Number.isSafeInteger(run.id) || run.id < 1 ||
    !Number.isSafeInteger(trustedWorkflowId) || trustedWorkflowId < 1 ||
    typeof trustedContext !== 'string' || !/^[A-Za-z0-9_.\/-]+$/u.test(trustedContext)) return false
  return status?.context === trustedContext && status.state === 'success' &&
    status.creator?.login === 'github-actions[bot]' &&
    status.target_url === `https://github.com/${repo}/actions/runs/${run.id}` &&
    run.name === 'PR quality gate' && run.conclusion === 'success' &&
    run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.workflow_id === trustedWorkflowId &&
    run.repository?.full_name === repo
}

export function assessMerge(facts: Facts): Decision {
  if (!repoPattern.test(facts.repo) || !Number.isSafeInteger(facts.number) || facts.number < 1 ||
    !shaPattern.test(facts.headSha)) return { allow: false, reason: 'invalid-target' }
  const receipt = facts.receipt
  if (receipt?.kind !== 'review-completed' || receipt.repo !== facts.repo || receipt.number !== facts.number ||
    receipt.headSha !== facts.headSha || !receipt.runId || !digestPattern.test(receipt.diffSha256)) {
    return { allow: false, reason: 'invalid-review-receipt' }
  }
  if (!receipt.mergeProposed) return { allow: false, reason: 'not-proposed' }
  if (!hasExpectedWorkflowReference(facts.repo, facts.headSha, facts.status, facts.run,
    facts.trustedWorkflowId, facts.trustedContext)) {
    return { allow: false, reason: 'quality-workflow-reference-missing' }
  }
  if (facts.approval === null || !sameReview(facts.approval, receipt)) {
    return { allow: false, reason: 'owner-approval-missing' }
  }
  // A workflow link cannot authenticate the candidate and base it checked.
  return { allow: false, reason: 'owner-actions-draft' }
}

export async function executeMerge(facts: Facts, api: {
  currentHead(): Promise<string>
  consumeApproval(): Promise<boolean>
  merge(sha: string): Promise<void>
}): Promise<void> {
  const decision = assessMerge(facts)
  if (!decision.allow) throw new Error(`merge refused: ${decision.reason}`)
  if (await api.currentHead() !== facts.headSha) throw new Error('PR head changed before merge')
  if (!await api.consumeApproval()) throw new Error('owner approval was already spent')
  // GitHub must enforce this SHA too: a force push can land after our last read.
  await api.merge(facts.headSha)
}
