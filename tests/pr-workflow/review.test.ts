import { describe, expect, it } from 'vitest'
import { fixedReviewPrompt, PrReviewReader } from '../../src/pr-workflow/review.js'

const SHA = 'a'.repeat(40)
const NEXT_SHA = 'b'.repeat(40)
const target = { repo: 'owner/project', number: 12, headSha: SHA, baseRef: 'main', baseSha: NEXT_SHA }

describe('PR review inputs', () => {
  it('keeps PR-authored text out of the human prompt', () => {
    const prompt = fixedReviewPrompt(12)
    expect(prompt).toContain('PR #12')
    expect(prompt).toContain('propose_merge')
    expect(prompt).not.toContain('title')
    expect(() => fixedReviewPrompt(-1)).toThrow()
  })

  it('returns metadata only through a tool result and logs an actual stable diff read', async () => {
    const reads: Array<{ headSha: string; diffSha256: string }> = []
    const reader = new PrReviewReader({
      getPull: async () => ({ ...target, title: 'private payload', body: 'untrusted body', headSha: SHA }),
      getDiff: async () => 'diff --git a/x b/x\n+safe',
    }, target, (read) => reads.push(read))
    expect(await reader.readPr()).toContain('private payload')
    expect(reads).toEqual([])
    expect(await reader.readDiff()).toContain('diff --git')
    expect(reads).toEqual([{ headSha: SHA, diffSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }])
  })

  it('refuses a moving head and records no diff read', async () => {
    let calls = 0
    const reads: unknown[] = []
    const reader = new PrReviewReader({
      getPull: async () => ({ ...target, title: 'ordinary title', body: '', headSha: ++calls === 1 ? SHA : NEXT_SHA }),
      getDiff: async () => 'diff --git a/x b/x',
    }, target, (read) => reads.push(read))
    await expect(reader.readDiff()).rejects.toThrow(/head or base changed/)
    expect(reads).toEqual([])
  })

  it('refuses a moved base with the same head and records no diff read', async () => {
    let calls = 0
    const reads: unknown[] = []
    const reader = new PrReviewReader({
      getPull: async () => ({ ...target, title: 'ordinary title', body: '',
        baseRef: ++calls === 1 ? 'main' : 'release' }),
      getDiff: async () => 'diff --git a/x b/x',
    }, target, (read) => reads.push(read))
    await expect(reader.readDiff()).rejects.toThrow(/head or base changed/)
    expect(reads).toEqual([])
  })

})
