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
