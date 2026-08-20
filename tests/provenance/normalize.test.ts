import { describe, expect, it } from 'vitest'
import {
  SHINGLE_STEP,
  SHINGLE_WINDOW,
  atoms,
  formatHash,
  hash,
  hashCodes,
  mapWords,
  normalize,
  originalSpan,
  parseHash,
  shingles,
} from '../../src/provenance/normalize.js'

describe('normalize', () => {
  it('collapses spaces and newlines', () => {
    expect(normalize('set   the price\n\n  to one rouble')).toBe('set the price to one rouble')
  })

  it('folds to lower case', () => {
    expect(normalize('SeT tHe Price')).toBe('set the price')
  })

  it('removes compatibility forms through NFKC', () => {
    expect(normalize('ﬁle')).toBe('file')
  })

  it('a non-breaking and a thin space are the same space', () => {
    expect(normalize('price\u00A0one\u2009rouble')).toBe('price one rouble')
  })

  it('trims the edges', () => {
    expect(normalize('  \n edge  ')).toBe('edge')
  })
})

describe('shingles', () => {
  it('yields nothing on a short text', () => {
    expect(shingles('short', 1).size).toBe(0)
  })

  it('yields windows on a long text', () => {
    const text = 'a'.repeat(SHINGLE_WINDOW + 8)
    expect(shingles(text, 1).size).toBeGreaterThan(0)
  })

  it('the step thins the set out', () => {
    // The text must be varied: in a string of one letter all the windows
    // coincide, the set collapses to a single element at any step, and the
    // test would be comparing one with one.
    const text = Array.from({ length: 200 }, (_, i) =>
      String.fromCharCode(97 + ((i * 37) % 26)),
    ).join('')
    expect(shingles(text, 8).size).toBeLessThan(shingles(text, 1).size)
  })

  it('a text exactly one window long yields one shingle', () => {
    expect(shingles('x'.repeat(SHINGLE_WINDOW), 1).size).toBe(1)
  })

  it('the default step is declared and equals eight', () => {
    expect(SHINGLE_STEP).toBe(8)
    expect(SHINGLE_WINDOW).toBe(32)
  })
})

describe('atoms', () => {
  it('pulls out links', () => {
    expect(atoms('look at https://evil.example/a right here')).toContain('https://evil.example/a')
  })

  it('pulls out long identifiers', () => {
    expect(atoms('item 1937461028 is withdrawn')).toContain('1937461028')
  })

  it('does not count ordinary words as atoms', () => {
    expect(atoms('set the price to one rouble')).toEqual([])
  })

  it('a long word without digits is not an atom', () => {
    // Otherwise any retelling of what was read goes to quarantine: ordinary
    // text has more long words in it than identifiers.
    expect(atoms('reformatting responsibilities documentation')).toEqual([])
  })

  it('pulls out an e-mail address and an absolute path', () => {
    const found = atoms('write to ops@evil.example or drop it into /var/spool/out')
    expect(found).toContain('ops@evil.example')
    expect(found).toContain('/var/spool/out')
  })

  it('a sentence-final dot does not belong to the token', () => {
    expect(atoms('go to https://evil.example/a.')).toContain('https://evil.example/a')
    // A path is caught by the same rule: otherwise a path mentioned at the end
    // of a phrase lands in the index with a foreign dot and stops being found
    // at all.
    expect(atoms('it lies in the file /var/www/promo/rules.md.')).toContain('/var/www/promo/rules.md')
    expect(atoms('the link [here](/var/www/promo/rules.md)')).toContain('/var/www/promo/rules.md')
  })

  it("a link's case does not save it from matching", () => {
    expect(atoms('HTTPS://EVIL.EXAMPLE/A')).toContain('https://evil.example/a')
  })
})

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash('one and the same')).toBe(hash('one and the same'))
  })

  it('different input gives different output', () => {
    expect(hash('the first')).not.toBe(hash('the second'))
  })

  it('glues two independent hashes together', () => {
    // A single 32-bit hash on a large text collides inevitably, and a
    // collision is an extra question to the user out of nowhere.
    expect(hash('anything at all').split(':')).toHaveLength(2)
  })
})

describe('mapWords', () => {
  it('the normalized text matches normalize', () => {
    const source = 'Set   THE PRICE\n\nto one  rouble'
    expect(mapWords(source).text).toBe(normalize(source))
    expect(mapWords(source).exact).toBe(true)
  })

  it("returns a word's bounds in the original text", () => {
    const source = 'start   MIDDLE end'
    const map = mapWords(source)
    const at = map.text.indexOf('middle')
    expect(originalSpan(map, at, at + 'middle'.length)).toEqual([
      source.indexOf('MIDDLE'),
      source.indexOf('MIDDLE') + 'MIDDLE'.length,
    ])
  })

  it('a span is widened to word bounds rather than cut letter by letter', () => {
    const source = 'alpha beta gamma'
    const map = mapWords(source)
    // We ask for the middle of the word "beta" — we get the whole word.
    const at = map.text.indexOf('beta') + 1
    expect(originalSpan(map, at, at + 2)).toEqual([6, 10])
  })

  it('there is no span in an empty text', () => {
    expect(originalSpan(mapWords('   '), 0, 5)).toBe(null)
  })

  it('an inexact map yields no span', () => {
    // The caller must be able to tell "the span is right here" from "could not
    // map it", otherwise quarantine will cut the wrong piece and leave the
    // injection in place.
    const map = { ...mapWords('alpha beta'), exact: false }
    expect(originalSpan(map, 0, 5)).toBe(null)
  })
})

describe('hashCodes, formatHash, parseHash', () => {
  it('hash is a formatted pair of numbers', () => {
    expect(hash('wind')).toBe(formatHash(hashCodes('wind', 0, 4)))
  })

  it('computing in place matches computing over a cut substring', () => {
    // On the hot path the substring is not cut out. Were these two paths to
    // diverge, the index and the query would stop matching, and taint would
    // slip by.
    const text = 'zero one two three four five six seven eight nine ten'
    expect(hashCodes(text, 5, 37)).toEqual(hashCodes(text.slice(5, 37), 0, 32))
  })

  it('parses its own key back', () => {
    const codes = hashCodes('some window of the text', 0, 20)
    expect(parseHash(formatHash(codes))).toEqual(codes)
  })

  it('does not undertake to parse a foreign key', () => {
    expect(parseHash('')).toBe(null)
    expect(parseHash('abc')).toBe(null)
    expect(parseHash('a:b:c')).toBe(null)
    expect(parseHash('ZZ:1')).toBe(null)
    expect(parseHash('\u00A3:1')).toBe(null)
    expect(parseHash(':1')).toBe(null)
    expect(parseHash('zzzzzzzz:1')).toBe(null)
  })
})

describe('the size of a source does not switch provenance off', () => {
  // The provenance of a large answer is computed on the hook's hot path, and
  // the hook has a timeout, while an expired hook means a pass. So the cost
  // must grow linearly: otherwise ballast on a page would switch the second
  // axis off.
  //
  // The budget has a wide margin deliberately. It separates a linear pass from
  // a quadratic one rather than measuring the machine's speed: on this input
  // the current code spends fractions of a second, and a quadratic one would
  // spend tens.
  const BUDGET = 3_000

  it('two megabytes are mapped in a fraction of the hook budget', () => {
    // The lines differ by their number: identical windows would collapse in
    // the set, and the check would count a handful of hashes instead of tens
    // of thousands.
    const big = Array.from(
      { length: 30_000 },
      (_unused, i) => `line ${i} of an ordinary document, long enough for a matching window.`,
    ).join('\n')

    const started = Date.now()
    const windows = shingles(normalize(big))

    expect(Date.now() - started).toBeLessThan(BUDGET)
    expect(windows.size).toBeGreaterThan(100_000)
  }, BUDGET * 4)
})
