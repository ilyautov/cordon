import { stripInvisible } from './invisible.js'
import { stripHiddenHtml } from './hidden-html.js'
import { detectMixedScript } from './mixed-script.js'
import { detectEncoded } from './encoded.js'
import { detectPadding } from './padding.js'
import type { SanitizeResult } from './types.js'

export type { Finding, FindingKind, SanitizeResult } from './types.js'

/**
 * Order matters: invisible characters are stripped first so they cannot
 * interfere with HTML parsing — `disp<zwsp>lay:none` inside a style attribute
 * would otherwise go unrecognized; hidden markup is removed after that.
 *
 * The script and encoding detectors run over the union of the cleaned text and
 * the samples of what was removed — otherwise an instruction encoded INSIDE a
 * hidden block would disappear together with the block and nobody would learn
 * about it.
 *
 * Padding is measured on the text with invisible characters gone and the
 * markup still in place: a line of zero-width spaces must count as blank,
 * while the gap a removed `<script>` leaves behind is not something the
 * attacker wrote.
 */
export function sanitize(input: string): SanitizeResult {
  const invisible = stripInvisible(input)
  const html = stripHiddenHtml(invisible.clean)

  const removed = html.findings.map((finding) => finding.sample).join('\n')
  const searchable = removed ? `${html.clean}\n${removed}` : html.clean

  return {
    clean: html.clean,
    findings: [
      ...invisible.findings,
      ...html.findings,
      ...detectMixedScript(searchable),
      ...detectEncoded(searchable),
      ...detectPadding(invisible.clean),
    ],
  }
}
