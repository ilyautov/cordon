export type FindingKind = 'invisible' | 'hidden-html' | 'annotation' | 'mixed-script' | 'encoded' | 'padding'

/**
 * A finding is a risk signal, not a verdict. Cordon blocks nothing on the
 * strength of findings: the decision belongs to the policy and the gate.
 */
export interface Finding {
  kind: FindingKind
  /** The subkind, for example 'zero-width' or 'hidden-element'. */
  detail: string
  /** A truncated sample of what was found, for the human-facing report. */
  sample: string
}

export interface SanitizeResult {
  /** The text without fragments that are invisible or hidden from a human. */
  clean: string
  findings: Finding[]
}

/**
 * Characters that steer a terminal or forge a line instead of being read:
 * controls, format characters, the line and paragraph separators.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * Collapses a fragment to one line, spells out any control character in it
 * and truncates it to max characters.
 *
 * A sample is the attacker's own text on its way to the human's terminal,
 * through `scan`, `audit` and the hook's report. A bare escape, a bell or a
 * backspace in it would redraw our own line; the invisible module strips
 * the ANSI sequences it recognises, and a sample must not depend on which
 * ones those are.
 */
export function sample(text: string, max = 80): string {
  const oneLine = text
    .replace(/\s+/g, ' ')
    .replace(CONTROL, (char) => `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`)
    .trim()
  const chars = [...oneLine]
  if (chars.length <= max) return oneLine
  if (max <= 0) return ''
  if (max === 1) return '…'
  return chars.slice(0, max - 1).join('') + '…'
}
