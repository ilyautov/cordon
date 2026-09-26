/**
 * Values the user assigned to a controlled field in their own message.
 *
 * A controlled field is one whose value changes something the target alone
 * does not say: an amount, a date, a status. The exposure rule answers where
 * a call goes, and a lookup can vouch for the right payment while the page
 * talks the agent into the wrong amount on it (the battery's
 * lookup/right-id-wrong-amount). Codex's review of the design set the shape:
 * a number anywhere in the message is not an authorization. "Don't pay
 * 99000" and "pay 50 of the 1200" state no amount. Only the field's own name,
 * one connector, and the value count.
 *
 * The rule is syntactic and cannot be anything else here (invariant 1): a
 * user who writes "did you set amount = 1200?" has assigned it. What the
 * syntax refuses, it refuses on review findings:
 *
 * - No connector, no assignment. "The amount 99000 you paid was disputed"
 *   assigned 99000 while a bare space counted (Kimi).
 * - A bare value is a number, a date or a time, whole: 1200, 1,200.50,
 *   2026-10-01, 10:00. Any other form assigns nothing rather than being kept
 *   as written, since a string argument spelled the same way would then
 *   match it. 1.200,50 is not read as 1.200, 50 or 120050, and a number cut
 *   by a space, 1 200, is not read as 1 (Codex). Anything else goes in
 *   quotes: status to 'Approved'.
 * - The text is not normalized. NFKC folded an enclosed one into 1 and a
 *   superscript two into 2, values the user never wrote (Codex and Kimi).
 * - A quoted span is read whole, from left to right: the words of a memo the
 *   user quoted assign nothing to another field (Codex and Kimi). A quote
 *   opens only where a word starts, so the apostrophe in "don't" opens none.
 */

const CONNECTOR = String.raw`\s*(?:=|:|→|\s(?:to|is|at|equals)\s)\s*`
const QUOTED = String.raw`(?<![\p{L}\p{N}])(?:'([^'\n]{1,64})'|"([^"\n]{1,64})")(?![\p{L}\p{N}])`
const BARE = String.raw`([+-]?\d[^\s'"]{0,63})(?![^\s'"])`

const NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/u

/** Pairs of a declared field name and a value the message assigned to it. */
export function assignments(text: string, fields: readonly string[]): Array<[string, string]> {
  if (fields.length === 0) return []
  const spelled = new Map<string, string>()
  for (const field of fields) {
    for (const spelling of [field, field.replace(/[_-]+/gu, ' ')]) spelled.set(spelling.toLowerCase(), field)
  }
  const names = [...spelled.keys()].sort((a, b) => b.length - a.length).map(escape)
  // One pass, leftmost first: an assignment takes its quoted value with it,
  // and a quoted span that is not a value is consumed without being read.
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}_-])(${names.join('|')})(?![\p{L}\p{N}_-])${CONNECTOR}(?:${QUOTED}|${BARE})|${QUOTED}`,
    'giu',
  )
  const out: Array<[string, string]> = []
  for (const match of text.matchAll(pattern)) {
    if (match[1] === undefined) continue
    const field = spelled.get(match[1].toLowerCase())!
    const quoted = match[2] ?? match[3]
    if (quoted !== undefined) {
      if (quoted.trim() !== '') out.push([field, quoted.trim()])
      continue
    }
    const value = bare(match[4]!, text.slice(match.index + match[0].length))
    if (value !== null) out.push([field, value])
  }
  return out
}

/**
 * A bare value as the gate compares it, or null. Trailing punctuation goes;
 * thousands separators in the 1,200.50 form go; a number followed by a space
 * and more digits is a number the space cut, and assigns nothing.
 */
function bare(token: string, rest: string): string | null {
  const trimmed = token.replace(/[.,;:!?)\]]+$/u, '')
  if (/^\s\d/u.test(rest)) return null
  if (NUMBER.test(trimmed)) return trimmed.replace(/,/gu, '')
  if (DATE.test(trimmed) || TIME.test(trimmed)) return trimmed
  return null
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
