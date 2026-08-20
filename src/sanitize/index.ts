import { stripInvisible } from './invisible.js'
import { stripHiddenHtml } from './hidden-html.js'
import { detectMixedScript } from './mixed-script.js'
import { detectEncoded } from './encoded.js'
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
    ],
  }
}
