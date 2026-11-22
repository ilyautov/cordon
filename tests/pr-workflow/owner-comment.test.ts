import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixedComment, publishReviewComment, type CommentRequest } from '../../src/pr-workflow/owner-comment.js'
import type { ReviewReceipt } from '../../src/pr-workflow/store.js'

const receipt: ReviewReceipt = {
  kind: 'review-completed', repo: 'owner/project', number: 12, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40), diffSha256: 'c'.repeat(64),
  runId: '599845b6-4408-4eae-9b35-036d78362b44', mergeProposed: true,
}
const ownerId = 25
const endpoint = 'repos/owner/project/issues/12/comments'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cordon-comment-test-'))
  roots.push(root)
  const comments: Array<{ id: number; body: string; user: { id: number } }> = []
  const post = vi.fn((body: string) => {
    const comment = { id: comments.length + 100, body, user: { id: ownerId } }
    comments.push(comment)
    return comment
  })
  const api = vi.fn((request: CommentRequest): unknown => {
    if (request.method === 'POST' && request.endpoint === endpoint) return post(request.body)
    if (request.method === 'GET' && request.endpoint === 'user') return { id: ownerId }
    if (request.method === 'GET' && request.endpoint === endpoint + '?per_page=100' && request.paginate) {
      return [[], comments]
    }
    throw new Error('unexpected comment request')
  })
  return { root, comments, post, api }
}

describe('publishing the fixed owner comment', () => {
  it('posts one comment and recognizes the same snapshot even after a new review run', () => {
    const { root, api, post } = fixture()
    expect(publishReviewComment(root, receipt, api)).toEqual({ commentId: 100, published: true })
    const rereview = { ...receipt, runId: '086ca26b-0705-4e4c-9b9b-435745e16ba3' }
    expect(publishReviewComment(root, rereview, api)).toEqual({ commentId: 100, published: false })
    expect(post).toHaveBeenCalledExactlyOnceWith(fixedComment(receipt))
  })

  it('finds a matching comment from the authenticated owner among other authors', () => {
    const { root, api, comments, post } = fixture()
    const body = fixedComment(receipt)
    comments.push({ id: 200, body, user: { id: 11 } }, { id: 201, body, user: { id: ownerId } })
    expect(publishReviewComment(root, receipt, api)).toEqual({ commentId: 201, published: false })
    expect(post).not.toHaveBeenCalled()
  })

  it('publishes its own review when an identical comment only exists from another author', () => {
    const { root, api, comments, post } = fixture()
    comments.push({ id: 200, body: fixedComment(receipt), user: { id: 11 } })
    expect(publishReviewComment(root, receipt, api)).toEqual({ commentId: 101, published: true })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps the first publication attempt exclusive while it is in progress', () => {
    const { root, api, comments, post } = fixture()
    post.mockImplementationOnce((body) => {
      expect(() => publishReviewComment(root, receipt, api)).toThrow(/publication.*unconfirmed/i)
      const comment = { id: 100, body, user: { id: ownerId } }
      comments.push(comment)
      return comment
    })
    expect(publishReviewComment(root, receipt, api)).toEqual({ commentId: 100, published: true })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('finds a committed comment after its POST reply was lost', () => {
    const { root, api, comments, post } = fixture()
    post.mockImplementationOnce((body) => {
      comments.push({ id: 100, body, user: { id: ownerId } })
      throw new Error('response lost')
    })
    expect(() => publishReviewComment(root, receipt, api)).toThrow(/publication.*unconfirmed/i)
    expect(publishReviewComment(root, receipt, api)).toEqual({ commentId: 100, published: false })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('withholds repeated POST when the first outcome remains unconfirmed', () => {
    const { root, api, post } = fixture()
    post.mockImplementationOnce(() => { throw new Error('response lost') })
    expect(() => publishReviewComment(root, receipt, api)).toThrow(/publication.*unconfirmed/i)
    expect(() => publishReviewComment(root, receipt, api)).toThrow(/publication.*unconfirmed/i)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('refuses publication if a duplicate lookup page is malformed', () => {
    const { root, api, post } = fixture()
    api.mockReturnValueOnce({ id: ownerId }).mockReturnValueOnce([{ body: 'invalid page' }])
    expect(() => publishReviewComment(root, receipt, api)).toThrow(/comment list/)
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses to repost when the author of a matching comment is unknown', () => {
    const { root, api, post } = fixture()
    api.mockReturnValueOnce({ id: ownerId })
      .mockReturnValueOnce([[{ id: 200, body: fixedComment(receipt), user: {} }]])
    expect(() => publishReviewComment(root, receipt, api)).toThrow(/comment author/)
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps the old comment intact when publishing a separate reviewed snapshot', () => {
    const { root, api, comments } = fixture()
    publishReviewComment(root, receipt, api)
    const newReceipt = { ...receipt, headSha: 'd'.repeat(40), baseSha: 'e'.repeat(40), diffSha256: 'f'.repeat(64) }
    publishReviewComment(root, newReceipt, api)
    expect(comments.map(({ body }) => body)).toEqual([fixedComment(receipt), fixedComment(newReceipt)])
  })
})
