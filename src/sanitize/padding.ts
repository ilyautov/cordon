import { type Finding, sample } from './types.js'

/**
 * How many blank lines in a row make a finding.
 *
 * VirusTotal's October 2026 survey of 35 878 agent skills found the payload
 * below 78 to 825 blank lines in 56 of the 90 skills that hid it at all, the
 * most common hiding technique by far. Honest files space their sections
 * with a handful of blank lines; the loyalty corpus goes up to about twenty.
 * Fifty sits well above honest spacing and below every padded sample seen.
 */
export const PADDING_THRESHOLD = 50

/**
 * A blank line: nothing on it, or nothing an editor shows. The survey's WHO
 * sample filled its 733 lines with spaces, which look exactly like
 * emptiness. So does a line of format characters or default-ignorable code
 * points, and the invisible module strips only some of those: a zero-width
 * joiner is cut between letters and kept on a line of its own, so a padding
 * made of U+200C would have read as 733 lines of text. Blankness is decided
 * here, by what renders as nothing, and not by what another module happened
 * to remove. U+0085 is a line break that `\s` does not know, and the blank
 * Braille pattern and the Hangul fillers render as nothing without being
 * ignorable by the standard.
 */
const BLANK = /^[\s\u0085\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u115F\u1160\u3164\uFFA0]*$/u

/**
 * Finds text that follows a long run of blank lines.
 *
 * Nothing here is invisible character by character, so the invisible module
 * is silent, and nothing is hidden by markup. What hides the text is the
 * shape of the file: a reviewer stops scrolling where the document appears
 * to end, and a scanner that truncates long inputs never reaches the tail.
 *
 * This is a risk axis, not a removal axis: nothing is cut. The text after
 * the run is in plain sight for anyone who gets there, and cutting it would
 * eat an honest appendix. Blank lines at the end of a file hide nothing and
 * give no finding.
 */
export function detectPadding(input: string): Finding[] {
  const findings: Finding[] = []
  const lines = input.split(/\r\n|\r|\n/u)

  let run = 0
  for (const line of lines) {
    if (BLANK.test(line)) {
      run += 1
      continue
    }
    if (run >= PADDING_THRESHOLD) {
      findings.push({ kind: 'padding', detail: 'blank-lines', sample: `${run} blank lines, then: ${sample(line)}` })
    }
    run = 0
  }

  return findings
}
