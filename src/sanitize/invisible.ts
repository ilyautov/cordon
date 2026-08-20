import { type Finding, sample } from './types.js'

/**
 * Tier 1: characters with no legitimate use in text read as data. Removed
 * unconditionally.
 */
const ALWAYS: ReadonlyArray<{ detail: string; re: RegExp }> = [
  { detail: 'zero-width', re: /[\u200B\u2060-\u2064\uFEFF]/gu },
  { detail: 'soft-hyphen', re: /\u00AD/gu },
  { detail: 'invisible-joiner-mark', re: /[\u034F\u180E]/gu },
  { detail: 'unicode-tags', re: /[\u{E0000}-\u{E007F}]/gu },
  { detail: 'bidi-control', re: /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu },
  // Interlinear annotation marks. In plain text they mean nothing: they
  // exist for ruby-annotation markup, which is not passed in here, while
  // arbitrary text can perfectly well be hidden between them.
  { detail: 'annotation-control', re: /[\uFFF9-\uFFFB]/gu },
  // Formatting characters the consortium marked deprecated. By definition
  // no legitimate use is left.
  { detail: 'deprecated-format', re: /[\u206A-\u206F]/gu },
  {
    // CSI, OSC terminated by BEL or ST, and lone two-byte escapes. The agent
    // reads text as data, not as a terminal, so we cut generously.
    detail: 'ansi-escape',
    re: /\u001B(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/gu,
  },
]

/** Scripts in which joiners mean nothing. */
const PLAIN_LETTER = String.raw`[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]`

/**
 * Real Hangul: syllables, jamo and compatibility forms, with the fillers
 * U+115F, U+1160, U+3164 and U+FFA0 themselves excluded.
 *
 * The exclusion is mandatory. The fillers carry Script=Hangul, so a
 * "the neighbour is Hangul" check without it would let a chain of fillers
 * through: the second one would see the first on its left and consider
 * itself part of a word.
 */
const HANGUL_REAL =
  '[\uAC00-\uD7A3\u1100-\u115E\u1161-\u11FF\uA960-\uA97C\uD7B0-\uD7FB\u3131-\u3163\u3165-\u318E\uFFA1-\uFFDC]'

/**
 * Tier 2: characters that are sometimes legitimate. Removed only where they
 * certainly mean nothing.
 *
 * ZWJ and ZWNJ carry meaning in emoji sequences, Indic scripts and Arabic
 * shaping. Between Latin, Cyrillic and Greek letters they mean nothing and
 * serve only to break a word apart.
 *
 * A variation selector has a handful of legitimate positions: U+FE0E and
 * U+FE0F after an emoji, U+FE0F additionally inside a keycap sequence, the
 * rest after a Han character. Everywhere else it is a hiding channel.
 */
const CONTEXTUAL: ReadonlyArray<{ detail: string; re: RegExp }> = [
  {
    detail: 'joiner-between-letters',
    re: new RegExp(`(?<=${PLAIN_LETTER})[\u200C\u200D](?=${PLAIN_LETTER})`, 'gu'),
  },
  {
    // U+FE0F asks for the emoji presentation, U+FE0E for the text one. Both
    // are legitimate after an emoji. U+FE0F is also legitimate between a
    // keycap base and U+20E3 (sequences like "1" + selector + keycap):
    // cutting it there breaks an emoji the human can see.
    detail: 'variation-selector',
    re: /(?<!\p{Extended_Pictographic})(?:\uFE0E|\uFE0F(?!\u20E3)|(?<![#*0-9])\uFE0F)/gu,
  },
  {
    detail: 'variation-selector',
    re: /(?<!\p{Script=Han})[\uFE00-\uFE0D\u{E0100}-\u{E01EF}]/gu,
  },
  {
    // The fillers are legitimate only inside Hangul composition.
    detail: 'blank-filler',
    re: new RegExp(`(?<!${HANGUL_REAL})[\u115F\u1160\u3164\uFFA0](?!${HANGUL_REAL})`, 'gu'),
  },
  {
    // The blank Braille pattern is legitimate as a space between non-blank
    // patterns.
    detail: 'blank-filler',
    re: /(?<![\u2801-\u28FF])\u2800(?![\u2801-\u28FF])/gu,
  },
]

/**
 * Strips the invisible layer. Tier 1 is always cut, tier 2 only in context,
 * so that emoji, Indic scripts and Japanese text are not damaged.
 */
export function stripInvisible(input: string): { clean: string; findings: Finding[] } {
  const findings: Finding[] = []
  let clean = input

  for (const { detail, re } of [...ALWAYS, ...CONTEXTUAL]) {
    const matches = clean.match(re)
    if (!matches) continue
    findings.push({
      kind: 'invisible',
      detail,
      sample: `${matches.length} ${matches.length === 1 ? 'occurrence' : 'occurrences'}: ${sample(
        matches.map(codePoint).join(' '),
        60,
      )}`,
    })
    clean = clean.replace(re, '')
  }

  return { clean, findings }
}

function codePoint(char: string): string {
  const code = char.codePointAt(0) ?? 0
  return 'U+' + code.toString(16).toUpperCase().padStart(4, '0')
}
