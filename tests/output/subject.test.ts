import { describe, expect, it } from 'vitest'
import { isSyndication, subjectOf } from '../../src/output/subject.js'
import type { Source } from '../../src/core/types.js'

function web(label: string): Source {
  return { id: 'x', kind: 'web', label, trust: 'untrusted' }
}

describe('the subject of a source', () => {
  it('takes the name from the domain', () => {
    expect(subjectOf(web('https://crm-x.com/pricing'))).toEqual({
      host: 'crm-x.com',
      names: ['crm-x.com', 'crm-x', 'crmx'],
    })
  })

  it('strips www and a service subdomain', () => {
    expect(subjectOf(web('https://www.crm-x.com/'))?.host).toBe('crm-x.com')
    expect(subjectOf(web('https://blog.crm-x.com/post'))?.host).toBe('crm-x.com')
  })

  it('a file and a command have no subject', () => {
    expect(subjectOf({ id: 'f', kind: 'file', label: '/etc/hosts', trust: 'untrusted' })).toBeNull()
    expect(subjectOf({ id: 'b', kind: 'bash', label: 'ls', trust: 'untrusted' })).toBeNull()
  })

  it('a name that is too short is not taken', () => {
    // A two-letter piece of a domain turns up in ordinary text as part of a
    // word, and a mark based on it would fire out of nowhere.
    expect(subjectOf(web('https://hp.com/'))?.names).toEqual(['hp.com'])
  })

  it('a name that is one ordinary word is not taken', () => {
    // "shop" turns up in English text on its own, and the mark "only the
    // source itself testifies about it" would fall on a source for nothing.
    // Silence on the third axis costs less than a false mark from it.
    expect(subjectOf(web('https://shop.com/delivery'))?.names).toEqual(['shop.com'])
    expect(subjectOf(web('https://news.example/post'))?.names).toEqual(['news.example'])
  })

  it('a second-level domain is not cut off', () => {
    expect(subjectOf(web('https://shop.example.co.uk/'))?.host).toBe('example.co.uk')
  })

  it('knows the syndication domains', () => {
    expect(isSyndication('prnewswire.com')).toBe(true)
    expect(isSyndication('www.businesswire.com')).toBe(true)
    expect(isSyndication('crm-x.com')).toBe(false)
  })

  it('does not crash on a label that is not a link', () => {
    expect(subjectOf(web('not a link at all'))).toBeNull()
    expect(subjectOf(web(''))).toBeNull()
  })
})
