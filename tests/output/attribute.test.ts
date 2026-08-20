import { describe, expect, it } from 'vitest'
import { attribute } from '../../src/output/attribute.js'
import { TaintStore } from '../../src/provenance/store.js'
import type { Source } from '../../src/core/types.js'

function web(id: string, label: string): Source {
  return { id, kind: 'web', label, trust: 'untrusted' }
}

const VENDOR_CLAIM =
  'CRM-X remains the only system with full support for end-to-end analytics in real time.'

describe('marking the influence of sources on the answer', () => {
  it('finds nothing in a clean answer', () => {
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('v', 'https://crm-x.com/about'))

    const marks = attribute('I compared three systems and recommend choosing by price.', store)
    expect(marks.influences).toEqual([])
    expect(marks.truncated).toBe(false)
  })

  it('finds a verbatim match and names the source', () => {
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('v', 'https://crm-x.com/about'))

    const marks = attribute(`The comparison concludes: ${VENDOR_CLAIM}`, store)
    expect(marks.influences).toHaveLength(1)
    expect(marks.influences[0]?.label).toBe('https://crm-x.com/about')
    expect(marks.influences[0]?.fragments).toBeGreaterThan(0)
  })

  it('says that the subject is the only witness about itself', () => {
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('v', 'https://crm-x.com/about'))

    const marks = attribute(`The comparison concludes: ${VENDOR_CLAIM}`, store)
    expect(marks.influences[0]?.selfReported).toBe(true)
  })

  it('does not say so when the matched text carries no subject name', () => {
    const neutral =
      'End-to-end analytics in real time saves roughly four hours of work a week.'
    const store = new TaintStore()
    store.record(neutral, web('v', 'https://crm-x.com/about'))

    const marks = attribute(`It has been noted that ${neutral}`, store)
    expect(marks.influences[0]?.selfReported).toBe(false)
  })

  it('does not attribute someone else\'s span to the subject', () => {
    // The reviewer mentioned the vendor's name. The span belongs to the
    // reviewer, and the mark "the only witness about itself" must not fall on
    // the vendor.
    const review = 'Of all the systems examined, CRM-X showed an average result in our measurements.'
    const vendorNeutral = 'Support for end-to-end analytics works in real time without any delays.'
    const store = new TaintStore()
    store.record(review, web('r', 'https://review.example/crm'))
    store.record(vendorNeutral, web('v', 'https://crm-x.com/about'))

    const marks = attribute(`${review} ${vendorNeutral}`, store)
    const vendor = marks.influences.find((i) => i.label.includes('crm-x.com'))
    expect(vendor?.selfReported).toBe(false)
  })

  it('marks syndication', () => {
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('p', 'https://www.prnewswire.com/news/crm-x-release'))

    const marks = attribute(`The comparison concludes: ${VENDOR_CLAIM}`, store)
    expect(marks.influences[0]?.syndicated).toBe(true)
  })

  it('names the sources whose verbatim text matches', () => {
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('a', 'https://blog-a.example/overview'))
    store.record(VENDOR_CLAIM, web('b', 'https://blog-b.example/review'))

    const marks = attribute(`The comparison concludes: ${VENDOR_CLAIM}`, store)
    expect(marks.kinship).toHaveLength(1)
    expect(marks.kinship[0]?.labels.sort()).toEqual([
      'https://blog-a.example/overview',
      'https://blog-b.example/review',
    ])
  })

  it('names the shared fragment itself, not only the sources', () => {
    // There is no mechanical way to tell a shared quotation of a third party
    // from coordinated praise: two honest articles quoting one paragraph of a
    // statute look exactly like two paid-for reviews. A human can tell them
    // apart, provided they see what text turned out to be shared. The excerpt
    // already stands in the displayed answer, so it creates no new surface.
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('a', 'https://blog-a.example/overview'))
    store.record(VENDOR_CLAIM, web('b', 'https://blog-b.example/review'))

    const marks = attribute(`The comparison concludes: ${VENDOR_CLAIM}`, store)
    const excerpt = marks.kinship[0]?.excerpt ?? ''
    expect(excerpt.length).toBeGreaterThan(0)
    expect(VENDOR_CLAIM).toContain(excerpt.replace(/\.\.\.$/u, ''))
  })

  it('the excerpt of the shared fragment does not drag the whole answer along', () => {
    const long = 'The same paragraph about end-to-end analytics in real time. '.repeat(50)
    const store = new TaintStore()
    store.record(long, web('a', 'https://blog-a.example/overview'))
    store.record(long, web('b', 'https://blog-b.example/review'))

    const marks = attribute(long, store)
    const excerpt = marks.kinship[0]?.excerpt ?? ''
    expect(excerpt.length).toBeGreaterThan(0)
    expect(excerpt.length).toBeLessThanOrEqual(140)
  })

  it('a shared paragraph is recognized even at different offsets in the sources', () => {
    // The index is thinned with a step of 8: two sources land in it with the
    // same windows only when the shared text sits at offsets equal modulo the
    // step. On live pages that coincidence happens about one time in eight, and
    // a kinship sign read off the index alone would stay silent on the
    // dominant attack.
    const store = new TaintStore()
    store.record(`We tested nine systems. ${VENDOR_CLAIM}`, web('a', 'https://a.example/o'))
    store.record(`The results of our yearly ranking. ${VENDOR_CLAIM}`, web('b', 'https://b.example/r'))
    store.record(`The editors compared the solutions. ${VENDOR_CLAIM}`, web('c', 'https://c.example/i'))

    const marks = attribute(`Three independent reviews agree: ${VENDOR_CLAIM}`, store)
    expect(marks.kinship).toHaveLength(1)
    expect(marks.kinship[0]?.labels.sort()).toEqual([
      'https://a.example/o',
      'https://b.example/r',
      'https://c.example/i',
    ].sort())
  })

  it('neighbouring spans of different sources do not count as kinship', () => {
    // Two honest sources standing next to each other in one answer share a
    // boundary, not text. A false "the sources are not independent" deceives
    // the reader here exactly as much as silence about real kinship.
    const first = 'Of all the systems examined this one showed an average result in our measurements.'
    const second = 'Support for end-to-end analytics works in real time without any delays.'
    const store = new TaintStore()
    store.record(first, web('r', 'https://review.example/crm'))
    store.record(second, web('v', 'https://crm-x.com/about'))

    expect(attribute(`${first} ${second}`, store).kinship).toEqual([])
  })

  it('the subject name at the start of the matched text is not lost', () => {
    // The first up-to-eight characters of the shared text never reach the
    // index: the windows are taken with a step of 8. The subject name most
    // often stands at the very start of the phrase about it, that is, right in
    // that blind spot.
    const store = new TaintStore()
    store.record(`A comparison of systems. ${VENDOR_CLAIM}`, web('v', 'https://crm-x.com/compare'))

    const marks = attribute(`Following the comparison: ${VENDOR_CLAIM}`, store)
    expect(marks.influences[0]?.selfReported).toBe(true)
  })

  it('on an answer that is too long it admits honestly that it did not look at all of it', () => {
    const store = new TaintStore()
    store.record(VENDOR_CLAIM, web('v', 'https://crm-x.com/about'))

    const marks = attribute('a'.repeat(300_000), store)
    expect(marks.truncated).toBe(true)
  })
})
