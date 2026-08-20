/** The shingle window length, in characters of normalized text. */
export const SHINGLE_WINDOW = 32

/**
 * The step at which shingles are stored in the index. On lookup every shingle
 * is taken, so any match of SHINGLE_WINDOW + SHINGLE_STEP - 1 characters is
 * guaranteed to be found. This is the declared detection threshold.
 */
export const SHINGLE_STEP = 8

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/**
 * The set of window hashes. Two independent hashes are glued into one string:
 * a collision of a single 32-bit hash on a large text is inevitable, and a
 * collision produces a false positive. A false positive is safe, and one
 * extra question to the user costs less than its absence.
 */
export function shingles(normalized: string, step: number = SHINGLE_STEP): Set<string> {
  const result = new Set<string>()
  if (normalized.length < SHINGLE_WINDOW) return result
  for (let i = 0; i + SHINGLE_WINDOW <= normalized.length; i += step) {
    result.add(hash(normalized.slice(i, i + SHINGLE_WINDOW)))
  }
  return result
}

/**
 * Tokens that carry identity and are therefore dangerous on their own, even
 * when short: links, paths, e-mail addresses, long alphanumeric identifiers.
 * An item number is shorter than the shingle threshold, yet substituting
 * precisely that is the attack.
 */
export function atoms(text: string): string[] {
  const found = new Set<string>()
  const source = text.normalize('NFKC')

  for (const match of source.matchAll(/(?:https?:\/\/|mailto:)\S+/giu)) {
    found.add(trimTail(match[0]))
  }
  for (const match of source.matchAll(/\b[\w.-]+@[\w-]+\.[a-z]{2,}\b/giu)) {
    found.add(match[0].toLowerCase())
  }
  for (const match of source.matchAll(/(?<![\w/])[/~][\w./-]{4,}/gu)) {
    // A dot belongs to the path character class, so a sentence-final dot
    // sticks to a path just as it sticks to a link. Without trimming, a path
    // from a document lands in the index with a foreign tail and never
    // matches again — that is, it quietly stops being found.
    found.add(trimTail(match[0]))
  }
  for (const match of source.matchAll(/\b[a-z0-9][a-z0-9_-]{7,}\b/giu)) {
    const token = match[0].toLowerCase()
    // A long ordinary word is not an identifier: it has no digits in it.
    if (/\d/u.test(token)) found.add(token)
  }

  return [...found]
}

/**
 * Two independent 32-bit hashes of a window, computed in place.
 *
 * Kept apart from the string key, because on the hot path building the string
 * costs more than the hashing itself: two toString(36) calls and a template
 * per offset eat an order of magnitude. Numbers let a window be rejected
 * before the key is needed at all.
 */
/** Trailing punctuation belongs to the sentence, not to the token. */
function trimTail(token: string): string {
  return token.toLowerCase().replace(/[.,;:!?)\]]+$/u, '')
}

export function hashCodes(text: string, from: number, to: number): [number, number] {
  let fnv = 0x811c9dc5
  let djb = 5381
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i)
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0
    djb = (Math.imul(djb, 33) + code) >>> 0
  }
  return [fnv, djb]
}

export function formatHash(codes: readonly [number, number]): string {
  return `${codes[0].toString(36)}:${codes[1].toString(36)}`
}

/**
 * Parsing a key back. Needed to restore the numeric prefilter after the index
 * has been read from disk.
 *
 * null means "this key was not built by us". Accepting such a key silently
 * would lose a taint record forever: the prefilter would not let it through,
 * and the tainted fragment would pass as clean.
 */
export function parseHash(key: string): [number, number] | null {
  const parts = key.split(':')
  if (parts.length !== 2) return null
  const [left, right] = parts
  if (left === undefined || right === undefined) return null
  if (!/^[0-9a-z]+$/u.test(left) || !/^[0-9a-z]+$/u.test(right)) return null
  const first = Number.parseInt(left, 36)
  const second = Number.parseInt(right, 36)
  if (first > 0xffffffff || second > 0xffffffff) return null
  return [first, second]
}

export function hash(chunk: string): string {
  return formatHash(hashCodes(chunk, 0, chunk.length))
}

/**
 * A map of the normalized text: where each of its words lay in the original.
 *
 * Needed to bring a match found back into the coordinates of the original
 * value. Estimating "by the ratio of lengths" will not do here: normalization
 * eats whitespace unevenly, and the span slips exactly where the text is
 * formatted crookedly, that is, in an attack. A slipped span means quarantine
 * will cut the neighbouring piece and leave the injection in place.
 */
export interface WordMap {
  /** The normalized text. When exact === true it equals normalize(source). */
  text: string
  /** The start offset of each word in the normalized text. */
  atNormalized: number[]
  /** The bounds of the same word in the original text, end exclusive. */
  atOriginal: Array<[number, number]>
  /**
   * false when the word-by-word assembly diverged from normalizing the whole
   * string. NFKC can change text with an eye on its neighbours, and then the
   * map lies.
   */
  exact: boolean
}

export function mapWords(text: string): WordMap {
  const atNormalized: number[] = []
  const atOriginal: Array<[number, number]> = []
  const words: string[] = []
  let length = 0

  for (const match of text.matchAll(/\S+/gu)) {
    if (words.length > 0) length += 1 // the separating space
    atNormalized.push(length)
    atOriginal.push([match.index, match.index + match[0].length])
    const word = match[0].normalize('NFKC').toLowerCase()
    words.push(word)
    length += word.length
  }

  const built = words.join(' ')
  return { text: built, atNormalized, atOriginal, exact: built === normalize(text) }
}

/**
 * The span of the original text covering a given span of the normalized one.
 *
 * Expanded to word boundaries: covering an extra letter is safe, failing to
 * cover a needed one is not. Returns null when the mapping is unreliable, so
 * that the caller does not mistake a guess for coordinates.
 */
export function originalSpan(map: WordMap, from: number, to: number): [number, number] | null {
  if (!map.exact) return null
  const count = map.atNormalized.length
  if (count === 0 || to <= from) return null

  // The last word starting no later than from: the span begins there.
  let low = 0
  let high = count - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((map.atNormalized[middle] ?? 0) <= from) low = middle
    else high = middle - 1
  }

  let start = -1
  let end = -1
  for (let i = low; i < count && (map.atNormalized[i] ?? 0) < to; i++) {
    const bounds = map.atOriginal[i]
    if (!bounds) break
    if (start < 0) start = bounds[0]
    end = bounds[1]
  }

  return start < 0 ? null : [start, end]
}
