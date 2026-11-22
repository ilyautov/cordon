import { describe, expect, it, vi } from 'vitest'
import { getPinnedDiff, getPullSnapshot } from '../../src/pr-workflow/github.js'

const target = { repo: 'example/project', number: 12, baseRef: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }
const compare = `repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`
const jsonMedia = 'application/vnd.github+json'
const diffMedia = 'application/vnd.github.diff'
const patch = '@@ -1,2 +1,2 @@\n Keep this line.\n-Original spelling.\n+Updated spelling.'
const diff = 'diff --git a/notes.txt b/notes.txt\nindex 1234567..0123456 100644\n--- a/notes.txt\n+++ b/notes.txt\n' + patch + '\n'
const changedFile = { filename: 'notes.txt', additions: 1, deletions: 1, patch }
const metadata = { base_commit: { sha: target.baseSha }, files: [changedFile] }
const pr = { number: target.number, state: 'open', title: 'Spelling change', body: null, head: { sha: target.headSha },
  base: { ref: target.baseRef, sha: target.baseSha, repo: { full_name: 'Example/Project' } } }

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

function comparison(raw = Buffer.from(diff), details: unknown = metadata) {
  return vi.fn((endpoint: string, accept: string) => {
    if (endpoint === `${compare}?per_page=1` && accept === jsonMedia) return json(details)
    if (endpoint === compare && accept === diffMedia) return raw
    throw new Error('unexpected GitHub request')
  })
}

describe('GitHub PR snapshot', () => {
  it('uses the live target ref when the PR metadata still reports an older base SHA', () => {
    const liveBase = 'c'.repeat(40)
    const read = vi.fn((endpoint: string) => {
      if (endpoint.endsWith('/git/ref/heads/main')) return json({ ref: 'refs/heads/main',
        object: { type: 'commit', sha: liveBase } })
      if (endpoint.endsWith('/git/ref/pull/12/head')) return json({ ref: 'refs/pull/12/head',
        object: { type: 'commit', sha: target.headSha } })
      return json(pr)
    })
    expect(getPullSnapshot(target.repo, target.number, read).baseSha).toBe(liveBase)
  })

  it('refuses a pull ref that disagrees with the indexed PR head', () => {
    const read = vi.fn((endpoint: string) => {
      if (endpoint.endsWith('/git/ref/heads/main')) return json({ ref: 'refs/heads/main',
        object: { type: 'commit', sha: target.baseSha } })
      if (endpoint.endsWith('/git/ref/pull/12/head')) return json({ ref: 'refs/pull/12/head',
        object: { type: 'commit', sha: 'd'.repeat(40) } })
      return json(pr)
    })
    expect(() => getPullSnapshot(target.repo, target.number, read)).toThrow(/head ref/)
  })

  it('pins base and head from the named repository and normalizes an absent body', () => {
    const read = vi.fn((endpoint: string) => {
      if (endpoint.endsWith('/git/ref/heads/main')) return json({ ref: 'refs/heads/main',
        object: { type: 'commit', sha: target.baseSha } })
      if (endpoint.endsWith('/git/ref/pull/12/head')) return json({ ref: 'refs/pull/12/head',
        object: { type: 'commit', sha: target.headSha } })
      return json(pr)
    })
    expect(getPullSnapshot(target.repo, target.number, read)).toEqual({ ...target, title: 'Spelling change', body: '' })
    expect(read.mock.calls).toEqual([
      [`repos/${target.repo}/pulls/12`, jsonMedia],
      [`repos/${target.repo}/git/ref/heads/main`, jsonMedia],
      [`repos/${target.repo}/git/ref/pull/12/head`, jsonMedia],
    ])
  })

  it.each([
    { ...pr, number: 13 },
    { ...pr, state: 'closed' },
    { ...pr, head: { sha: 'feature' } },
    { ...pr, base: { ...pr.base, ref: '' } },
    { ...pr, base: { ...pr.base, sha: 'main' } },
    { ...pr, base: { ...pr.base, repo: { full_name: 'example/other' } } },
    { ...pr, title: undefined },
  ])('refuses a different or incomplete snapshot', (response) => {
    expect(() => getPullSnapshot(target.repo, target.number, () => json(response))).toThrow()
  })

  it('rejects an invalid repository before making a request', () => {
    const read = vi.fn(() => json(pr))
    expect(() => getPullSnapshot('example/..', target.number, read)).toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('immutable GitHub diff', () => {
  it('returns the raw diff unchanged and reads only the pinned comparison', () => {
    const read = comparison()
    expect(getPinnedDiff(target, read)).toBe(diff)
    expect(read.mock.calls).toEqual([
      [`${compare}?per_page=1`, jsonMedia],
      [compare, diffMedia],
    ])
  })

  it.each([
    ['empty', Buffer.alloc(0)],
    ['invalid UTF-8', Buffer.concat([Buffer.from(diff), Buffer.from([0xff])])],
    ['oversized', Buffer.alloc(4 * 1024 * 1024 + 1)],
    ['truncated hunk', Buffer.from(diff.slice(0, -'+Updated spelling.\n'.length))],
    ['missing final newline', Buffer.from(diff.slice(0, -1))],
    ['unexpected suffix', Buffer.from(diff + 'Unrelated status information.\n')],
  ])('refuses an %s comparison response', (_name, raw) => {
    expect(() => getPinnedDiff(target, comparison(raw))).toThrow()
  })

  it.each([
    ['unexpected base', { ...metadata, base_commit: { sha: 'c'.repeat(40) } }],
    ['missing changed file', { ...metadata, files: [changedFile, { ...changedFile, filename: 'other.txt' }] }],
    ['different hunk', { ...metadata, files: [{ ...changedFile, patch: patch.replace('Updated', 'Corrected') }] }],
    ['changed-file cap', { ...metadata, files: Array.from({ length: 300 },
      (_, index) => ({ ...changedFile, filename: `notes-${index}.txt` })) }],
  ])('refuses incomplete GitHub metadata (%s)', (_name, details) => {
    expect(() => getPinnedDiff(target, comparison(undefined, details))).toThrow()
  })

  it('accepts a mode-only change with no text hunks', () => {
    const modeDiff = 'diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n'
    const details = { ...metadata, files: [{ filename: 'script.sh', additions: 0, deletions: 0 }] }
    expect(getPinnedDiff(target, comparison(Buffer.from(modeDiff), details))).toBe(modeDiff)
  })
})
