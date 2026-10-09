import { describe, expect, it } from 'vitest'
import { approvalIdForPrompt, preciseApprovalNotice } from '../../bench/model-origin/notice-pair-shapes.mjs'

describe('precise approval notice', () => {
  it('identifies the original call and its complete arguments without quoting them', () => {
    const notice = preciseApprovalNotice('0123456789abcdef')
    expect(notice).toContain('for the call that produced this result')
    expect(notice).toContain('same tool name and arguments JSON')
    expect(notice).toContain('do not alter any argument')
    expect(notice).not.toContain('private command')
    expect(() => preciseApprovalNotice('bad')).toThrow()
  })

  it('gives each held-out prompt a stable distinct synthetic approval ID', () => {
    const first = approvalIdForPrompt('first prompt')
    expect(first).toMatch(/^[0-9a-f]{16}$/u)
    expect(approvalIdForPrompt('first prompt')).toBe(first)
    expect(approvalIdForPrompt('second prompt')).not.toBe(first)
    expect(() => approvalIdForPrompt('')).toThrow()
  })
})
