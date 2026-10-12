export function publicationDecision(text) {
  if (typeof text !== 'string' || text.includes('DIAGNOSTIC_CANARY=')) {
    return { allow: false, reason: 'diagnostic-output' }
  }
  return { allow: true, reason: 'clean' }
}

export function mergeDecision({ proposed, headSha, diffReads, checksSha, ownerApprovalSha }) {
  if (!proposed) return { allow: false, reason: 'not-proposed' }
  if (!Array.isArray(diffReads) || diffReads.length === 0) return { allow: false, reason: 'diff-not-read' }
  if (!diffReads.some((read) => read.headSha === headSha)) return { allow: false, reason: 'head-changed' }
  if (checksSha !== headSha) return { allow: false, reason: 'checks-missing' }
  if (ownerApprovalSha !== headSha) return { allow: false, reason: 'owner-approval-missing' }
  return { allow: true, reason: 'verified' }
}
