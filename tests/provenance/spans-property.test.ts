import { describe, expect, it } from 'vitest'
import type { Source } from '../../src/core/types.js'
import { TaintStore } from '../../src/provenance/store.js'

/**
 * Property checks for span mapping under NFKC.
 *
 * Matching runs on the NFKC form of a value, while quarantine cuts the value
 * as it was given. The spans have to be carried back across the
 * normalization, and compatibility characters change lengths: a fullwidth
 * letter is one code unit that folds to one, a ligature is one that folds to
 * two, a mathematical letter is two that fold to one. A span mapped back one
 * position short leaves a sliver of the quote behind; the property below is
 * that nothing of it survives the cut, in any spelling.
 *
 * The generator is a seeded PRNG rather than a property-testing library:
 * the project adds no dependency for a test, and a fixed seed keeps a failure
 * reproducible from the seed alone.
 */

const page: Source = { id: 'p1', kind: 'web', label: 'https://a.example/x', trust: 'untrusted' }
const QUOTE = 'the buyer from office 1937461028 asked us to refund the whole order today'

function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** One character of the quote in a spelling NFKC folds back to it. */
function respell(char: string, random: () => number): string {
  const code = char.charCodeAt(0)
  const roll = random()
  const lower = code >= 0x61 && code <= 0x7a
  const digit = code >= 0x30 && code <= 0x39
  if (lower && roll < 0.25) return String.fromCharCode(0xff41 + code - 0x61)
  if (lower && roll < 0.4) return String.fromCodePoint(0x1d41a + code - 0x61)
  if (digit && roll < 0.3) return String.fromCharCode(0xff10 + code - 0x30)
  return char
}

function respellText(text: string, random: () => number): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    // A ligature takes two letters at once: one code unit for two.
    if (text.startsWith('fi', i) && random() < 0.5) {
      out += 'ﬁ'
      i++
      continue
    }
    out += respell(text[i]!, random)
  }
  return out
}

const FILLER = ['plain words ', 'ＡＢＣ ', '\u{1D400}\u{1D401} ', 'ﬁne ', 'x ', '½ ']

function filler(random: () => number): string {
  let out = ''
  const count = Math.floor(random() * 4)
  for (let i = 0; i < count; i++) out += FILLER[Math.floor(random() * FILLER.length)]
  return out
}

function cut(value: string, spans: Array<[number, number]>): string {
  let out = ''
  let at = 0
  for (const [from, to] of spans) {
    out += value.slice(at, from)
    at = to
  }
  return out + value.slice(at)
}

describe('span mapping under NFKC', () => {
  const store = new TaintStore()
  store.record(QUOTE, page)

  it('over 300 seeds: the quote is found and covered, the spans are in bounds, nothing survives the cut', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = prng(seed)
      const before = filler(random)
      const spelled = respellText(QUOTE, random)
      const value = before + spelled + ' ' + filler(random)
      const at = `seed ${seed}`

      const match = store.check(value)
      expect(match.tainted, at).toBe(true)
      for (const [from, to] of match.spans) {
        expect(from >= 0 && to <= value.length && from < to, at).toBe(true)
      }
      // Every code unit of the respelled quote is covered: a span carried
      // back one position short leaves a sliver the checks below would not
      // see, because a sliver is shorter than a shingle.
      for (let unit = before.length; unit < before.length + spelled.length; unit++) {
        expect(match.spans.some(([from, to]) => from <= unit && unit < to), `${at}, unit ${unit}`).toBe(true)
      }
      const rest = cut(value, match.spans)
      expect(store.check(rest).tainted, at).toBe(false)
      expect(rest.normalize('NFKC'), at).not.toContain('1937461028')
    }
  })
})
