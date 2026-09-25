import { describe, expect, it } from 'vitest'
import { decodings } from '../../src/provenance/decode.js'

describe('decodings', () => {
  it('a value with nothing encoded in it produces nothing', () => {
    // The guard that keeps the extra passes off the hot path: almost every
    // argument goes through here and almost none of them are encoded.
    expect(decodings('an ordinary answer to a review')).toEqual([])
  })

  it('percent encoding is undone', () => {
    expect(decodings('item%201937461028')).toContain('item 1937461028')
  })

  it('double encoding is undone too', () => {
    expect(decodings('item%25201937461028')).toContain('item 1937461028')
  })

  it('a form-encoded space is undone', () => {
    expect(decodings('item+1937461028')).toContain('item 1937461028')
  })

  it('the two are undone together', () => {
    expect(decodings('item+1937461028%20sells')).toContain('item 1937461028 sells')
  })

  it('a stray percent is ordinary text, not an error', () => {
    // A discount, a format string, a literal percent. Throwing here would
    // turn prose into a refusal.
    expect(() => decodings('a 50% discount on everything')).not.toThrow()
    expect(decodings('a 50% discount on everything')).toEqual([])
  })

  it('the rounds are bounded', () => {
    // Nothing honest is encoded four times over, and an unbounded loop here
    // would be a way to spend the hook's whole timeout on one argument.
    expect(decodings('%'.repeat(3) + '2520'.repeat(40)).length).toBeLessThanOrEqual(4)
  })
})

describe('decodings: base64 and hex', () => {
  // The battery measured `encoding/base64-query-blob` passing provenance: a
  // page asks for the quotation "as base64 in the query", and the windows
  // stop matching. The detectors already existed in sanitize; the gate did
  // not use them.
  const text = 'Our price is lower than any competitor in the region this season.'

  it('a base64 run inside a value is decoded', () => {
    const blob = Buffer.from(text).toString('base64')
    expect(decodings(`https://a.example/c?d=${blob}`)).toContain(text)
  })

  it('the URL-safe alphabet too', () => {
    const blob = Buffer.from(text).toString('base64url')
    expect(decodings(`q=${blob}`)).toContain(text)
  })

  it('a hex run is decoded', () => {
    const blob = Buffer.from(text).toString('hex')
    expect(decodings(`x-${blob}`)).toContain(text)
  })

  it('a run that decodes to binary produces nothing', () => {
    // A commit hash or a random token decodes to bytes that are not text,
    // and comparing noise against the store is only cost.
    expect(decodings('3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550f')).toEqual([])
    expect(decodings('Zm9vYmFyYmF6cXV4AAECAwQFBgcICQoLDA0ODxAREhMUFRYX')).toEqual([])
  })
})
