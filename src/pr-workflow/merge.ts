type Status = { context: string; state: string; creator: { login: string }; target_url: string }
type Run = { id: number; name: string; conclusion: string; event: string; head_sha: string;
  head_branch: string; workflow_id: number; repository: { full_name: string } }
type Facts = { repo: string; number: number; headSha: string; proposed: boolean;
  diffReads: Array<{ headSha: string; diffSha256: string }>; status: Status; run: Run;
  approval: { repo: string; number: number; headSha: string }; trustedWorkflowId: number;
  trustedContext: string }
type Decision = { allow: boolean; reason: string }

const shaPattern = /^[a-f0-9]{40}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

export function trustedCheck(repo: string, sha: string, status: Status, run: Run,
  trustedWorkflowId: number, trustedContext: string): boolean {
  if (!repoPattern.test(repo) || repo.split('/').some((part) => part === '.' || part === '..') ||
    !shaPattern.test(sha) || !Number.isSafeInteger(run?.id) ||
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
  if (!facts.proposed) return { allow: false, reason: 'not-proposed' }
  if (!repoPattern.test(facts.repo) || !Number.isSafeInteger(facts.number) || facts.number < 1 ||
    !shaPattern.test(facts.headSha)) return { allow: false, reason: 'invalid-target' }
  if (!Array.isArray(facts.diffReads) || !facts.diffReads.some((read) =>
    read.headSha === facts.headSha && digestPattern.test(read.diffSha256))) {
    return { allow: false, reason: 'diff-not-read-at-head' }
  }
  if (!trustedCheck(facts.repo, facts.headSha, facts.status, facts.run,
    facts.trustedWorkflowId, facts.trustedContext)) {
    return { allow: false, reason: 'trusted-check-missing' }
  }
  if (facts.approval?.repo !== facts.repo || facts.approval.number !== facts.number ||
    facts.approval.headSha !== facts.headSha) return { allow: false, reason: 'owner-approval-missing' }
  return { allow: true, reason: 'verified' }
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
