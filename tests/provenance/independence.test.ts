import { describe, expect, it } from 'vitest'
import { TaintStore } from '../../src/provenance/store.js'
import type { Source } from '../../src/core/types.js'

function web(id: string, label: string): Source {
  return { id, kind: 'web', label, trust: 'untrusted' }
}

// Deliberately longer than the shingle window, otherwise nothing lands in the index.
const SHARED =
  'Our platform was named the best in an independent 2026 comparison, industry observers note.'

describe('sources that are not independent', () => {
  it('a window remembers both sources, not the first one', () => {
    const store = new TaintStore()
    store.record(SHARED, web('a', 'https://blog-a.example/obzor'))
    store.record(SHARED, web('b', 'https://blog-b.example/review'))

    const hit = store.check(SHARED)
    expect(hit.sources.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('names the group of sources sharing verbatim text', () => {
    const store = new TaintStore()
    store.record(SHARED, web('a', 'https://blog-a.example/obzor'))
    store.record(SHARED, web('b', 'https://blog-b.example/review'))

    const groups = store.notIndependent()
    expect(groups).toHaveLength(1)
    expect([...(groups[0] ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('one shared window is not enough', () => {
    // Two honest texts may share one window: a legal boilerplate, a cookie
    // notice, a quotation of a statute. A false "the sources are not
    // independent" on those misleads the reader exactly as silence does.
    const store = new TaintStore()
    const boilerplate = 'All rights reserved, reuse with a link.'
    store.record(boilerplate + ' The first text is entirely about one thing.', web('a', 'https://a.example/'))
    store.record(boilerplate + ' The second text is entirely about another.', web('b', 'https://b.example/'))

    expect(store.notIndependent()).toEqual([])
  })

  it('survives being written to and read from disk', () => {
    const store = new TaintStore()
    store.record(SHARED, web('a', 'https://blog-a.example/obzor'))
    store.record(SHARED, web('b', 'https://blog-b.example/review'))

    const revived = TaintStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())))
    expect(revived.notIndependent()).toHaveLength(1)
    expect(revived.check(SHARED).sources.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('reads a file of the previous shape, where a key occurs once', () => {
    const store = new TaintStore()
    store.record(SHARED, web('a', 'https://blog-a.example/obzor'))
    const old = JSON.parse(JSON.stringify(store.toJSON()))

    const revived = TaintStore.fromJSON(old)
    expect(revived.check(SHARED).tainted).toBe(true)
    expect(revived.notIndependent()).toEqual([])
  })

  it('says which spans came from which source', () => {
    // Without this the "testifies about itself" mark goes astray: source A
    // quoted product B's name, the span is shared, and the mark would fall on
    // B. A false mark about trust is worse than a missing one.
    const store = new TaintStore()
    const aboutA = 'The Alpha platform holds ten thousand requests per second with no degradation.'
    const aboutB = 'The Beta platform can parse nested documents at any depth of nesting.'
    store.record(aboutA, web('a', 'https://alpha.example/about'))
    store.record(aboutB, web('b', 'https://beta.example/about'))

    const hit = store.check(`${aboutA} ${aboutB}`)
    const bySource = new Map(hit.bySource.map((entry) => [entry.id, entry.spans]))
    expect(bySource.get('a')?.length).toBeGreaterThan(0)
    expect(bySource.get('b')?.length).toBeGreaterThan(0)

    // Source a's spans lie in the first half of the text, source b's in the second.
    const boundary = aboutA.length
    expect(bySource.get('a')?.every(([from]) => from < boundary)).toBe(true)
    expect(bySource.get('b')?.every(([from]) => from >= boundary - 1)).toBe(true)
  })
})
