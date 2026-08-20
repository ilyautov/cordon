import type { Finding, FindingKind } from '../sanitize/types.js'

/**
 * The finding kinds where neutralization actually cut something out.
 *
 * Only they mean the text had a layer hidden from the human, and only they
 * are talked about with the human. The kinds that merely mark —
 * `annotation`, `mixed-script`, `encoded` — occur on honest pages and in
 * honest files all the time: an image's alt text, a Latin letter inside a
 * Cyrillic word, base64 in a document's body. Speaking up about those would
 * train the human not to read our messages, and a false positive on
 * legitimate text is worse than a miss.
 */
const REMOVING: ReadonlySet<FindingKind> = new Set<FindingKind>(['invisible', 'hidden-html'])

/** The findings on which something was actually cut out. */
export function removingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => REMOVING.has(finding.kind))
}

/**
 * How many findings are named one by one in the report to the human.
 *
 * The report is printed to the terminal and goes into the hook's output
 * whole. A page with a thousand comments would give a megabyte and a half
 * that the human will not read and the harness may not accept — and hook
 * output that is not accepted means "allow", so an overflow would turn into a
 * pass. The remaining findings do not vanish silently: their count is
 * reported.
 */
const MAX_REPORTED = 12

/**
 * The report to the human about the findings. It carries the CONTENT of the
 * findings.
 *
 * Assembled the same way on both harnesses, because the human's question is
 * one and the same: what exactly was being slipped to them. Only the first
 * line differs — it says what Cordon did about it, and what it did differs
 * between harnesses and between cases.
 *
 * It is shown in the transcript and is NOT returned to the model. That
 * matters: hidden text that made it back into the context would become the
 * carrier of the injection on the next turn.
 */
export interface ReportAbout {
  /** The first line: what Cordon found and what it did about it. */
  lead: string
  /** The source label. It comes from the untrusted world, so it is defanged. */
  label: string
  /**
   * Whether the hidden text reached the model. Phrased separately in each
   * case and never omitted: for a human working through an incident, the
   * difference between "the model never saw this" and "the model read this"
   * matters more than the findings themselves.
   */
  note: string
}

export function humanReport(about: ReportAbout, findings: readonly Finding[]): string {
  const lines = findings
    .slice(0, MAX_REPORTED)
    .map((finding) => `  - ${finding.kind}/${finding.detail}: "${forHuman(finding.sample)}"`)
  const hidden = findings.length - MAX_REPORTED
  if (hidden > 0) lines.push(`  - and ${hidden} more findings of the same kind, not listed here`)
  return [about.lead, `Source: "${forHuman(about.label)}".`, about.note, ...lines].join('\n')
}

/**
 * Characters that reshape what has already been written: control characters,
 * invisible writing-direction marks, line and paragraph separators.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * Prepares text taken from an untrusted source for display to the human.
 *
 * This is literally the attacker's text, and it is printed into the human's
 * terminal. A newline in it would draw a counterfeit report line in our own
 * voice, and a bidi override would rearrange what we had already written. The
 * characters are not dropped but named by their code point: an invisible mark
 * is itself the finding, and the human must see that it was there.
 */
export function forHuman(text: string): string {
  return text.replace(CONTROL, (char) => {
    const code = char.codePointAt(0) ?? 0
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`
  })
}
