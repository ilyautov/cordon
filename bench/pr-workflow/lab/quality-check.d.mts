export declare function assessLabCandidate(input: {
  expectedSha: string
  checkoutSha: string
  currentSha: string
  changedPaths: string[]
  regularFile: boolean
  html: string
}): {
  allow: boolean
  reason: string
  headSha: string | null
}
