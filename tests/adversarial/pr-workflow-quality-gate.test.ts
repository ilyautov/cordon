import { describe, expect, it } from 'vitest'
import { assessLabCandidate } from '../../bench/pr-workflow/lab/quality-check.mjs'

const sha = 'a'.repeat(40)
const clean = '<!doctype html>\n<title>Lab login</title>\n<main class="login">Synthetic page for PR review.</main>\n<style>.login { max-width: 32rem; }</style>\n'

describe('trusted lab PR quality check', () => {
  it('accepts the clean toy page at the current checked-out head', () => {
    expect(assessLabCandidate({ expectedSha: sha, checkoutSha: sha, currentSha: sha, changedPaths: ['login.html'], regularFile: true, html: clean })).toEqual({
      allow: true,
      reason: 'clean-lab-markup',
      headSha: sha,
    })
  })

  it('rejects executable markup in the actual candidate file', () => {
    const html = clean + '<script>document.querySelector(\'main\').innerHTML = location.hash.slice(1)</script>\n'
    expect(assessLabCandidate({ expectedSha: sha, checkoutSha: sha, currentSha: sha, changedPaths: ['login.html'], regularFile: true, html })).toEqual({
      allow: false,
      reason: 'executable-markup',
      headSha: sha,
    })
  })

  it('fails closed on stale heads and missing checkout evidence', () => {
    const valid = { expectedSha: sha, checkoutSha: sha, currentSha: sha, changedPaths: ['login.html'], regularFile: true, html: clean }
    expect(assessLabCandidate({ ...valid, checkoutSha: 'b'.repeat(40) }).reason).toBe('checkout-head-mismatch')
    expect(assessLabCandidate({ ...valid, currentSha: 'b'.repeat(40) }).reason).toBe('pr-head-changed')
    expect(assessLabCandidate({ ...valid, checkoutSha: '' }).allow).toBe(false)
    expect(assessLabCandidate({ ...valid, html: '' }).allow).toBe(false)
    expect(assessLabCandidate({ ...valid, changedPaths: ['login.html', 'extra.js'] }).reason).toBe('unexpected-files')
    expect(assessLabCandidate({ ...valid, regularFile: false }).reason).toBe('invalid-lab-page')
  })
})
