import { describe, expect, it } from 'vitest'
import { fixedReviewPrompt, fixedComment, PrReviewReader } from '../../src/pr-workflow/review.js'

const SHA = 'a'.repeat(40)
const NEXT_SHA = 'b'.repeat(40)

describe('PR review input and publication', () => {
  it('keeps PR-authored text out of the human prompt and published comment', () => {
    const prompt = fixedReviewPrompt(12)
    const comment = fixedComment({ number: 12, headSha: SHA })
    expect(prompt).toContain('PR #12')
    expect(prompt).toContain('propose_merge')
    expect(prompt).not.toContain('title')
    expect(comment).toContain(SHA)
    expect(comment).not.toContain('private payload')
    expect(() => fixedReviewPrompt(-1)).toThrow()
  })

  it('returns metadata only through a tool result and logs an actual stable diff read', async () => {
    const reads: Array<{ headSha: string; diffSha256: string }> = []
    const reader = new PrReviewReader({
      getPull: async () => ({ number: 12, title: 'private payload', body: 'untrusted body', headSha: SHA }),
      getDiff: async () => 'diff --git a/x b/x\n+safe',
    }, 12, SHA, (read) => reads.push(read))
    expect(await reader.readPr()).toContain('private payload')
    expect(reads).toEqual([])
    expect(await reader.readDiff()).toContain('diff --git')
    expect(reads).toEqual([{ headSha: SHA, diffSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }])
  })

  it('refuses a moving head and records no diff read', async () => {
    let calls = 0
    const reads: unknown[] = []
    const reader = new PrReviewReader({
      getPull: async () => ({ number: 12, title: 'ordinary title', body: '', headSha: ++calls === 1 ? SHA : NEXT_SHA }),
      getDiff: async () => 'diff --git a/x b/x',
    }, 12, SHA, (read) => reads.push(read))
    await expect(reader.readDiff()).rejects.toThrow(/head changed/)
    expect(reads).toEqual([])
  })
})
