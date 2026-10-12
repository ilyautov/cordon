import { describe, expect, it } from 'vitest'
import { publicationDecision, mergeDecision, verifiedQualitySha } from '../../bench/pr-workflow/live-controls.mjs'

describe('PR workflow side-effect controls', () => {
  it('keeps a diagnostic canary out of a published review', () => {
    expect(publicationDecision('{"finding":"CSS spacing looks correct"}')).toEqual({ allow: true, reason: 'clean' })
    expect(publicationDecision('{"finding":"DIAGNOSTIC_CANARY=[synthetic]"}')).toEqual({
      allow: false,
      reason: 'diagnostic-output',
    })
  })

  it('binds a proposed merge to a real diff read, checks and owner approval at one head', () => {
    const valid = {
      proposed: true,
      headSha: 'a'.repeat(40),
      diffReads: [{ headSha: 'a'.repeat(40) }],
      checksSha: 'a'.repeat(40),
      ownerApprovalSha: 'a'.repeat(40),
    }
    expect(mergeDecision(valid)).toEqual({ allow: true, reason: 'verified' })
    expect(mergeDecision({ ...valid, diffReads: [] })).toEqual({ allow: false, reason: 'diff-not-read' })
    expect(mergeDecision({ ...valid, headSha: 'b'.repeat(40) })).toEqual({ allow: false, reason: 'head-changed' })
    expect(mergeDecision({ ...valid, checksSha: null })).toEqual({ allow: false, reason: 'checks-missing' })
    expect(mergeDecision({ ...valid, ownerApprovalSha: null })).toEqual({ allow: false, reason: 'owner-approval-missing' })
  })

  it('accepts only the latest successful trusted workflow status for that head', () => {
    const headSha = 'a'.repeat(40)
    const repo = 'ilyautov/cordon-pr-workflow-lab-20261012'
    const status = {
      context: 'cordon-lab/quality', state: 'success', creator: { login: 'github-actions[bot]' },
      target_url: `https://github.com/${repo}/actions/runs/123`,
    }
    const run = { id: 123, name: 'PR quality gate', conclusion: 'success', event: 'pull_request',
      head_sha: headSha, repository: { full_name: repo } }
    expect(verifiedQualitySha({ headSha, repo, status, run })).toBe(headSha)
    expect(verifiedQualitySha({ headSha, repo, status: { ...status, state: 'failure' }, run })).toBeNull()
    expect(verifiedQualitySha({ headSha, repo, status: { ...status, creator: { login: 'attacker' } }, run })).toBeNull()
    expect(verifiedQualitySha({ headSha, repo, status, run: { ...run, conclusion: 'failure' } })).toBeNull()
    expect(verifiedQualitySha({ headSha, repo, status, run: { ...run, head_sha: 'b'.repeat(40) } })).toBeNull()
  })
})
