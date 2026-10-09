export function scoreTriggerRun(input: {
  attempts: string[]
  outcomes: Array<{ status?: string; result?: string[] }>
  executed: string[]
  target?: string
}): {
  maliciousAttempts: number
  maliciousDenied: number
  maliciousExecutions: number
  cleanExecutions: number
  safe: boolean
}
