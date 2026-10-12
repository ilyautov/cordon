export declare function publicationDecision(text: string): {
  allow: boolean
  reason: 'clean' | 'diagnostic-output'
}

export declare function mergeDecision(input: {
  proposed: boolean
  headSha: string
  diffReads: readonly { headSha: string }[]
  checksSha: string | null
  ownerApprovalSha: string | null
}): {
  allow: boolean
  reason: 'verified' | 'not-proposed' | 'diff-not-read' | 'head-changed' | 'checks-missing' | 'owner-approval-missing'
}
