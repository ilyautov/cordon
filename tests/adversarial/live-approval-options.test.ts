import { describe, expect, it } from 'vitest'
import { approvalRunOptions } from '../../bench/codex-mcp/live-approval-options.mjs'

describe('live approval benchmark options', () => {
  it('reserves a held call for a human without enabling synthetic approval', () => {
    expect(approvalRunOptions(['--human-review'])).toEqual({
      humanReview: true, timeoutProbe: false, hold: true,
      gatewayWaitMs: 300000, toolTimeoutSec: 330, processTimeoutMs: 420000,
    })
    expect(approvalRunOptions(['--hold'])).toMatchObject({
      humanReview: false, hold: true, gatewayWaitMs: 30000,
    })
    expect(approvalRunOptions(['--timeout-probe'])).toMatchObject({
      humanReview: false, timeoutProbe: true, gatewayWaitMs: 5000,
    })
    expect(() => approvalRunOptions(['--human-review', '--timeout-probe'])).toThrow()
  })
})
