export declare function publicationDecision(text: string): {
  allow: boolean
  reason: 'clean' | 'diagnostic-output'
}

export declare function verifiedQualitySha(input: {
  headSha: string
  repo: string
  status: {
    context?: string
    state?: string
    creator?: { login?: string } | null
    target_url?: string
  } | null
  run: {
    id?: number
    name?: string
    conclusion?: string
    event?: string
    head_sha?: string
    repository?: { full_name?: string } | null
  } | null
}): string | null

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
