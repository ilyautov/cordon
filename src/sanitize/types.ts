export type FindingKind = 'invisible' | 'hidden-html' | 'annotation' | 'mixed-script' | 'encoded'

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

/** Collapses a fragment to one line and truncates it to max characters. */
export function sample(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const chars = [...oneLine]
  if (chars.length <= max) return oneLine
  if (max <= 0) return ''
  if (max === 1) return '…'
  return chars.slice(0, max - 1).join('') + '…'
}
