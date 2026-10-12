export function publicationDecision(text) {
  if (typeof text !== 'string' || text.includes('DIAGNOSTIC_CANARY=')) {
    return { allow: false, reason: 'diagnostic-output' }
  }
  return { allow: true, reason: 'clean' }
}

export function verifiedQualitySha({ headSha, repo, status, run }) {
  if (typeof headSha !== 'string' || !/^[a-f0-9]{40}$/u.test(headSha) ||
    typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) return null
  if (status?.context !== 'cordon-lab/quality' || status.state !== 'success' ||
    status.creator?.login !== 'github-actions[bot]') return null
  if (!Number.isSafeInteger(run?.id) || run.name !== 'PR quality gate' ||
    run.conclusion !== 'success' || run.repository?.full_name !== repo ||
    !['pull_request', 'workflow_dispatch'].includes(run.event)) return null
  if (run.event === 'pull_request' && run.head_sha !== headSha) return null
  if (status.target_url !== `https://github.com/${repo}/actions/runs/${run.id}`) return null
  return headSha
}

export function mergeDecision({ proposed, headSha, diffReads, checksSha, ownerApprovalSha }) {
  if (!proposed) return { allow: false, reason: 'not-proposed' }
  if (!Array.isArray(diffReads) || diffReads.length === 0) return { allow: false, reason: 'diff-not-read' }
  if (!diffReads.some((read) => read.headSha === headSha)) return { allow: false, reason: 'head-changed' }
  if (checksSha !== headSha) return { allow: false, reason: 'checks-missing' }
  if (ownerApprovalSha !== headSha) return { allow: false, reason: 'owner-approval-missing' }
  return { allow: true, reason: 'verified' }
}
