import { describe, expect, it } from 'vitest'
import { assessMerge, executeMerge, trustedCheck } from '../../src/pr-workflow/merge.js'

const SHA = 'a'.repeat(40)
const NEXT_SHA = 'b'.repeat(40)
const repo = 'owner/project'
const status = { context: 'cordon-pr/quality', state: 'success', creator: { login: 'github-actions[bot]' },
  target_url: 'https://github.com/owner/project/actions/runs/42' }
const run = { id: 42, name: 'PR quality gate', conclusion: 'success', event: 'workflow_dispatch',
  head_sha: 'c'.repeat(40), head_branch: 'main', workflow_id: 123,
  repository: { full_name: repo } }
const facts = { repo, number: 12, headSha: SHA, proposed: true, diffReads: [{ headSha: SHA,
  diffSha256: '1'.repeat(64) }], status, run, approval: { repo, number: 12, headSha: SHA },
  trustedWorkflowId: 123, trustedContext: 'cordon-pr/quality' }

describe('exact PR merge gate', () => {
  it('accepts only the trusted check run for the exact SHA', () => {
    expect(trustedCheck(repo, SHA, status, run, 123, 'cordon-pr/quality')).toBe(true)
    expect(trustedCheck(repo, SHA, { ...status, creator: { login: 'attacker' } }, run, 123, 'cordon-pr/quality')).toBe(false)
    expect(trustedCheck(repo, SHA, status, { ...run, head_branch: 'feature' }, 123, 'cordon-pr/quality')).toBe(false)
    expect(trustedCheck(repo, SHA, status, { ...run, conclusion: 'failure' }, 123, 'cordon-pr/quality')).toBe(false)
    expect(trustedCheck(repo, SHA, status, run, 999, 'cordon-pr/quality')).toBe(false)
    expect(trustedCheck(repo, SHA, status, { ...run, event: 'pull_request' }, 123, 'cordon-pr/quality')).toBe(false)
    expect(trustedCheck(repo, SHA, { ...status, context: 'other' }, run, 123, 'cordon-pr/quality')).toBe(false)
  })

  it('requires a real diff read, trusted CI and exact owner approval', () => {
    expect(assessMerge(facts)).toEqual({ allow: true, reason: 'verified' })
    expect(assessMerge({ ...facts, diffReads: [] }).allow).toBe(false)
    expect(assessMerge({ ...facts, diffReads: [{ headSha: NEXT_SHA, diffSha256: '1'.repeat(64) }] }).allow).toBe(false)
    expect(assessMerge({ ...facts, status: { ...status, state: 'failure' } }).allow).toBe(false)
    expect(assessMerge({ ...facts, approval: { ...facts.approval, headSha: NEXT_SHA } }).allow).toBe(false)
    expect(assessMerge({ ...facts, proposed: false }).allow).toBe(false)
  })

  it('checks the head again before consuming approval and passes the expected SHA to GitHub', async () => {
    const effects: string[] = []
    const api = {
      currentHead: async () => { effects.push('head'); return SHA },
      consumeApproval: async () => { effects.push('consume'); return true },
      merge: async (sha: string) => { effects.push(`merge:${sha}`) },
    }
    await executeMerge(facts, api)
    expect(effects).toEqual(['head', 'consume', `merge:${SHA}`])
    effects.length = 0
    await expect(executeMerge(facts, { ...api, currentHead: async () => NEXT_SHA })).rejects.toThrow(/head changed/)
    expect(effects).toEqual([])
  })
})
