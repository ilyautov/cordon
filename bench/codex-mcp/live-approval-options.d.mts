export type ApprovalRunOptions = {
  humanReview: boolean
  timeoutProbe: boolean
  hold: boolean
  gatewayWaitMs: number
  toolTimeoutSec: number | null
  processTimeoutMs: number
}

export declare const approvalRunOptions: (args: string[]) => ApprovalRunOptions
