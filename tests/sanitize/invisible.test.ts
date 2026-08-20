import { describe, it, expect } from 'vitest'
import { stripInvisible } from '../../src/sanitize/invisible.js'

describe('stripInvisible', () => {
  it('cuts out zero-width characters and reports the find', () => {
    const result = stripInvisible('he\u200Bllo')
    expect(result.clean).toBe('hello')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('invisible')
    expect(result.findings[0]?.detail).toBe('zero-width')
  })

  it('cuts out the Unicode tags instructions are hidden with', () => {
    const hidden = [...'ignore all']
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join('')
    const result = stripInvisible(`an ordinary review${hidden}`)
    expect(result.clean).toBe('an ordinary review')
    expect(result.findings[0]?.detail).toBe('unicode-tags')
  })

  it('cuts out writing-direction control characters', () => {
    const result = stripInvisible('invoice\u202Etext back to front')
    expect(result.clean).toBe('invoicetext back to front')
    expect(result.findings[0]?.detail).toBe('bidi-control')
  })

  it('cuts out ANSI sequences', () => {
    const result = stripInvisible('\u001B[31mred\u001B[0m')
    expect(result.clean).toBe('red')
    expect(result.findings[0]?.detail).toBe('ansi-escape')
  })

  it('leaves ordinary text alone', () => {
    const input = 'The item arrived on time, the packaging was intact. Five stars!'
    const result = stripInvisible(input)
    expect(result.clean).toBe(input)
    expect(result.findings).toEqual([])
  })

  it('reports how much was cut out', () => {
    const result = stripInvisible('a\u200Bb\u200Bc')
    expect(result.findings[0]?.sample).toContain('2')
  })

  it('cuts out an emoji selector outside a legitimate position', () => {
    const result = stripInvisible('ig\uFE0Fnore')
    expect(result.clean).toBe('ignore')
    expect(result.findings.some((f) => f.detail === 'variation-selector')).toBe(true)
  })

  it('keeps an emoji selector after an emoji', () => {
    const input = 'a heart \u2764\uFE0F in the text'
    const result = stripInvisible(input)
    expect(result.clean).toBe(input)
    expect(result.findings).toEqual([])
  })

  it('cuts out a chain of selectors used to hide data', () => {
    const result = stripInvisible('\u{1F600}\u{E0100}\u{E0101}\u{E0102}')
    expect(result.clean).toBe('\u{1F600}')
    expect(result.findings.some((f) => f.detail === 'variation-selector')).toBe(true)
  })

  it('cuts out invisible operators, the soft hyphen and the grapheme joiner', () => {
    expect(stripInvisible('ig\u2062nore').clean).toBe('ignore')
    expect(stripInvisible('ig\u00ADnore').clean).toBe('ignore')
    expect(stripInvisible('ig\u034Fnore').clean).toBe('ignore')
  })

  it('cuts out direction marks from the gap between the ranges', () => {
    expect(stripInvisible('ig\u200Enore').clean).toBe('ignore')
    expect(stripInvisible('ig\u200Fnore').clean).toBe('ignore')
    expect(stripInvisible('ig\u061Cnore').clean).toBe('ignore')
  })

  it('cuts out an OSC sequence hiding a link', () => {
    const osc = '\u001B]8;;https://evil.example\u0007a link\u001B]8;;\u0007'
    const result = stripInvisible(osc)
    expect(result.clean).toBe('a link')
    expect(result.findings.some((f) => f.detail === 'ansi-escape')).toBe(true)
  })

  it('does not tear a family emoji apart', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'
    const result = stripInvisible(`a photo ${family} here`)
    expect(result.clean).toContain(family)
    expect(result.findings).toEqual([])
  })

  it('leaves the joiner inside Devanagari alone', () => {
    const devanagari = '\u0915\u094D\u200D\u0937'
    const result = stripInvisible(devanagari)
    expect(result.clean).toBe(devanagari)
    expect(result.findings).toEqual([])
  })

  it('cuts out the joiner between Latin letters', () => {
    const result = stripInvisible('ig\u200Dnore')
    expect(result.clean).toBe('ignore')
    expect(result.findings.some((f) => f.detail === 'joiner-between-letters')).toBe(true)
  })

  it('keeps the selector in a keycap sequence', () => {
    const keycap = '1\uFE0F\u20E3'
    const result = stripInvisible(`step ${keycap} done`)
    expect(result.clean).toContain(keycap)
    expect(result.findings).toEqual([])
    // But a keycap grants no indulgence: a base outside [#*0-9] is concealment.
    expect(stripInvisible('a\uFE0F\u20E3').clean).toBe('a\u20E3')
  })

  it('keeps the text selector after an emoji', () => {
    const input = 'the sun \u2600\uFE0E in the text'
    const result = stripInvisible(input)
    expect(result.clean).toBe(input)
    expect(result.findings).toEqual([])
    expect(stripInvisible('ig\uFE0Enore').clean).toBe('ignore')
  })

  it('cuts out Korean fillers outside Korean text', () => {
    expect(stripInvisible('ig\u3164nore').clean).toBe('ignore')
    expect(stripInvisible('ig\u115Fnore').clean).toBe('ignore')
    expect(stripInvisible('ig\u1160nore').clean).toBe('ignore')
    expect(stripInvisible('ig\uFFA0nore').clean).toBe('ignore')
  })

  it('cuts out a chain of fillers whole', () => {
    const result = stripInvisible('ig\u3164\u3164\u3164nore')
    expect(result.clean).toBe('ignore')
    expect(result.findings.some((f) => f.detail === 'blank-filler')).toBe(true)
  })

  it('keeps a filler inside a Korean syllable', () => {
    const syllable = '\u1100\u1160\u11A8'
    expect(stripInvisible(syllable).clean).toBe(syllable)
  })

  it('leaves ordinary Korean text alone', () => {
    const korean = '한국어 테스트'
    const result = stripInvisible(korean)
    expect(result.clean).toBe(korean)
    expect(result.findings).toEqual([])
  })

  it('cuts out the blank Braille pattern outside Braille text', () => {
    expect(stripInvisible('ig\u2800\u2800nore').clean).toBe('ignore')
  })

  it('keeps the blank inside a Braille string', () => {
    const braille = '\u2813\u2800\u280A'
    expect(stripInvisible(braille).clean).toBe(braille)
  })

  it('cuts out interlinear annotations', () => {
    const result = stripInvisible('price \uFFF9100\uFFFA1\uFFFB dollars')
    expect(result.clean).toBe('price 1001 dollars')
    expect(result.findings.some((f) => f.detail === 'annotation-control')).toBe(true)
  })

  it('cuts out deprecated format characters', () => {
    const result = stripInvisible('ig\u206Ano\u206Fre')
    expect(result.clean).toBe('ignore')
    expect(result.findings.some((f) => f.detail === 'deprecated-format')).toBe(true)
  })

  it('keeps a filler next to old Korean jamo', () => {
    // Hangul Jamo Extended-A/B and the old compatibility jamo are real Korean
    // too, however rare: next to them a filler is legitimate.
    const extA = '\uA960\u1160'
    expect(stripInvisible(extA).clean).toBe(extA)
    const oldCompat = '\u3165\u3164\u3166'
    expect(stripInvisible(oldCompat).clean).toBe(oldCompat)
    // But a chain of fillers is still cut out whole.
    expect(stripInvisible('ig\u3164\u3164nore').clean).toBe('ignore')
  })
})
