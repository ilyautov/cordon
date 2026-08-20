import { type Finding, sample } from './types.js'

/**
 * Greek letters that have no twin in Latin or Cyrillic and that work as
 * symbols in ordinary text: Δ for temperature, μ for micro, Ω for ohm, and
 * π, σ, λ. They are excluded from the mixing signal because there is nothing
 * to substitute with them — a human sees them and confuses them with nothing
 * — while `ΔTmax`, `μsec` and `Ωmeter` turn up in any technical
 * documentation. The ambiguous letters are kept as signals: Γ, Π and Φ look
 * like Cyrillic Г, П and Ф, and the cost of an extra finding on them is lower
 * than the cost of missing a substitution.
 */
const GREEK_SYMBOL_ONLY = 'ΔΘΛΞΣΨΩβδζθλμξπςψω'

/**
 * Scripts whose mixing inside a word counts as a signal. The order defines
 * the shape of detail: 'Latin+Cyrillic'.
 */
const SCRIPTS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // The mathematical block U+1D400-U+1D7FF carries Script=Common, which
  // makes it invisible to script detection. A human, however, sees an
  // ordinary Latin letter, so a bold "S" plus Cyrillic is a substitution, not
  // mathematics. The block's characters remain legitimate and are not
  // removed.
  //
  // Its Latin part ends at U+1D6A5, Greek letters follow, and digits sit in a
  // separate tail from U+1D7CE. Mathematical Greek is deliberately in neither
  // this list nor the Greek signal: it is absent from the list of excluded
  // quantity symbols, and a physics document with a bold delta would get a
  // false finding.
  { name: 'Latin', re: /[\p{Script=Latin}\u{1D400}-\u{1D6A5}\u{1D7CE}-\u{1D7FF}]/u },
  { name: 'Cyrillic', re: /\p{Script=Cyrillic}/u },
  // Set subtraction from the v flag would require target ES2024, so the
  // symbols are cut off by a lookahead instead — same result.
  { name: 'Greek', re: new RegExp(`(?![${GREEK_SYMBOL_ONLY}])\\p{Script=Greek}`, 'u') },
]

/** A word is a continuous run of letters. Digits and punctuation separate. */
const WORD = /\p{L}+/gu

const MIN_WORD_LENGTH = 3

/**
 * Finds words with mixed scripts inside them. That is a signal of
 * substitution with lookalike characters. The text is NOT normalized: running
 * it through NFKC would damage legitimate ligatures and non-European
 * languages.
 *
 * This is a risk axis, not a removal axis: nothing is cut. Script mixing is
 * often harmless, so the boundary runs per word rather than per text — a
 * Russian paragraph containing the word `iPhone` is normal, while
 * `Сб<lat e>рбанк` is not.
 */
/**
 * Letters that, in source code and documentation, follow a backslash and
 * denote a control character rather than a letter.
 */
const ESCAPE_LETTERS = new Set([...'ntrfvbaeuxsSdDwWpP0'])

/**
 * Drops the leading letter of an escape sequence.
 *
 * A backslash does not count as a letter, so in text like `read\nчитай` the
 * letter `n` stuck to the Cyrillic word and produced a finding on a perfectly
 * honest document. Such text turns up in any source file and any piece of
 * documentation, and this is a risk axis, not a removal axis: its job is not
 * to get in the way of reading normal files.
 *
 * Exactly one letter is dropped, and only immediately after the backslash. A
 * word that still contains a substitution is found as before: `\nСбербank`
 * yields a finding even after `n` is dropped.
 */
function withoutEscapeHead(input: string, match: RegExpExecArray): string {
  const word = match[0]
  const at = match.index ?? 0
  if (at === 0 || input[at - 1] !== '\\') return word
  if (!ESCAPE_LETTERS.has(word[0] ?? '')) return word
  return word.slice(1)
}

export function detectMixedScript(input: string): Finding[] {
  const findings: Finding[] = []
  const reported = new Set<string>()

  for (const match of input.matchAll(WORD)) {
    const word = withoutEscapeHead(input, match)
    if (word.length < MIN_WORD_LENGTH) continue
    if (reported.has(word)) continue

    const present = SCRIPTS.filter((script) => script.re.test(word)).map((script) => script.name)
    if (present.length < 2) continue

    reported.add(word)
    findings.push({ kind: 'mixed-script', detail: present.join('+'), sample: sample(word) })
  }

  return findings
}
