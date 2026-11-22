import { sameCiIdentity, sameReview, type ApprovalRecord, type CiIdentity } from './owner-approvals.js'
import { sameSnapshot, type PrTarget, type ReviewReceipt } from './store.js'

type ReviewFacts = {
  receipt: ReviewReceipt
  current: PrTarget
  diffSha256: string
  ci: CiIdentity | null
}

type MergeFacts = ReviewFacts & { approval: ApprovalRecord | null }
type Decision = { allow: boolean; reason: string }

export function assessReview(facts: ReviewFacts): Decision {
  if (!sameSnapshot(facts.receipt, facts.current)) return { allow: false, reason: 'snapshot-changed' }
  if (facts.receipt.diffSha256 !== facts.diffSha256) return { allow: false, reason: 'diff-changed' }
  if (!facts.receipt.mergeProposed) return { allow: false, reason: 'not-proposed' }
  if (facts.ci === null) return { allow: false, reason: 'trusted-ci-missing' }
  return { allow: true, reason: 'review-and-ci-match' }
}

export function assessMerge(facts: MergeFacts): Decision {
  const review = assessReview(facts)
  if (!review.allow) return review
  if (facts.approval === null || facts.ci === null || !sameReview(facts.approval, facts.receipt) ||
      !sameCiIdentity(facts.approval.ci, facts.ci)) {
    return { allow: false, reason: 'owner-approval-missing' }
  }
  return { allow: true, reason: 'approved' }
}

export async function executeMerge<Result>(facts: MergeFacts, api: {
  currentSnapshot(): Promise<PrTarget>
  consumeApproval(approval: ApprovalRecord): Promise<boolean>
  /** The mutation must atomically enforce the full expected snapshot. */
  merge(expected: PrTarget): Promise<Result>
}): Promise<Result> {
  const decision = assessMerge(facts)
  if (!decision.allow || facts.approval === null) throw new Error(`merge refused: ${decision.reason}`)
  if (!sameSnapshot(await api.currentSnapshot(), facts.current)) throw new Error('PR head or base changed before merge')
  if (!await api.consumeApproval(facts.approval)) throw new Error('owner approval was already spent or expired')
  const { repo, number, headSha, baseRef, baseSha } = facts.current
  return api.merge({ repo, number, headSha, baseRef, baseSha })
}
