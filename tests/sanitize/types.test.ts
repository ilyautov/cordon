import { describe, it, expect } from 'vitest'
import { sample } from '../../src/sanitize/types.js'

describe('sample', () => {
  it('collapses spaces and line breaks', () => {
    expect(sample('  many\n\n  spaces  ')).toBe('many spaces')
  })

  it('truncates long text and adds an ellipsis', () => {
    const result = sample('a'.repeat(200), 10)
    expect(result).toHaveLength(10)
    expect(result.endsWith('…')).toBe(true)
  })

  it('leaves short text alone', () => {
    expect(sample('short', 80)).toBe('short')
  })

  it('does not exceed the limit at zero and negative max', () => {
    expect(sample('hello', 0)).toBe('')
    expect(sample('hello', -5)).toBe('')
  })

  it('returns only the ellipsis at max = 1', () => {
    expect(sample('hello', 1)).toBe('…')
  })

  it('does not split surrogate pairs', () => {
    const result = sample('😀'.repeat(20), 10)
    expect([...result]).toHaveLength(10)
    expect(result).not.toContain('�')
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('sample: control characters', () => {
  it('spells out controls, format characters and line separators', () => {
    const text = sample('ok\u0007 \u001B[31mred\u001B[0m \u200E \u2028x')
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(text).toContain('<U+0007>')
    expect(text).toContain('<U+001B>[31mred')
    expect(text).toContain('<U+200E>')
  })

  it('truncates after escaping, so a cut never splits an escape', () => {
    const text = sample('\u0007'.repeat(40), 20)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toMatch(/<U\+00$/u)
  })
})
