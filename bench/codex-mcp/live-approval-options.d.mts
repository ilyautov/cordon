export type ApprovalRunOptions = {
  humanReview: boolean
  timeoutProbe: boolean
  hold: boolean
  gatewayWaitMs: number
  toolTimeoutSec: number | null
  processTimeoutMs: number
}

export declare const approvalRunOptions: (args: string[]) => ApprovalRunOptions

export declare const humanReviewShowCommand: (paths: {
  home: string
  bundle: string
  id: string
  node: string
}) => string
