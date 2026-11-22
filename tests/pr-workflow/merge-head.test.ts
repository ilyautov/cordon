import { describe, expect, it } from 'vitest'
import { verifyMergeHead } from '../../src/pr-workflow/merge-head.js'
import type { MergeProfile, PrTarget } from '../../src/pr-workflow/store.js'

const target = { repo: 'owner/project', number: 12, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40) } satisfies PrTarget
const profile = { baseRef: 'main', statusAppId: 15368, statusAppSlug: 'github-actions',
  statusContext: 'cordon/exact-snapshot', mergeAppId: 456 } satisfies MergeProfile
const commit = { sha: target.headSha, parents: [{ sha: target.baseSha }] }
const app = { id: profile.statusAppId, slug: profile.statusAppSlug }
const status = { context: profile.statusContext, state: 'success',
  creator: { type: 'Bot', login: 'github-actions[bot]' } }

function verify(response: { commit?: unknown; app?: unknown; statuses?: unknown } = {}) {
  const endpoints = {
    [`repos/${target.repo}/git/commits/${target.headSha}`]: response.commit ?? commit,
    [`apps/${profile.statusAppSlug}`]: response.app ?? app,
    [`repos/${target.repo}/commits/${target.headSha}/statuses?per_page=100`]: response.statuses ?? [status],
  }
  verifyMergeHead(target, profile, (endpoint) => {
    expect(endpoints).toHaveProperty([endpoint])
    return endpoints[endpoint]
  })
}

describe('reviewed head and required App status', () => {
  it('accepts a single child of the pinned base with the required App status on the head', () => {
    expect(() => verify()).not.toThrow()
  })

  it.each([
    [{ sha: 'c'.repeat(40) }],
    [{ sha: target.baseSha }, { sha: 'c'.repeat(40) }],
  ])('refuses a head with parents other than the single pinned base %j', (...parents) => {
    expect(() => verify({ commit: { ...commit, parents } })).toThrow(/one commit/u)
  })

  it('checks the status publisher App ID', () => {
    expect(() => verify({ app: { ...app, id: app.id + 1 } })).toThrow(/required status App/u)
  })

  it.each([
    [[{ ...status, state: 'failure' }, status]],
    [[{ ...status, context: profile.statusContext.toUpperCase(), state: 'pending' }, status]],
    [[{ ...status, creator: { ...status.creator, type: 'User' } }]],
    [[{ ...status, creator: { ...status.creator, login: 'other[bot]' } }]],
    [[{ ...status, context: 'another/context' }]],
    [[]],
  ])('fails closed without a current success from the App for the exact context %j', (statuses) => {
    expect(() => verify({ statuses })).toThrow(/missing or unsuccessful/u)
  })
})
