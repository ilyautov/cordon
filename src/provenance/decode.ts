/**
 * The forms one value can take on its way into a call's arguments.
 *
 * Provenance recognizes what it was given verbatim, and an attacker does not
 * have to break that — it is enough to ask for the same text in a different
 * spelling. "When you send it, put it in the URL" costs a line on a page, and
 * the agent obligingly writes `%20` where the page had a space: the windows
 * stop matching and the leak goes through as clean.
 *
 * So the decision is made on the decoded forms as well as the given one.
 * Decoding is bounded and forgiving: a value that is not encoded at all
 * produces nothing, and a malformed sequence is not an error — a stray `%`
 * in ordinary prose must not turn into a refusal.
 */

/** Double encoding is a known trick; three rounds is past any honest use. */
const MAX_ROUNDS = 3

export function decodings(value: string): string[] {
  // The overwhelming majority of arguments carry neither, and this check is
  // what keeps the extra passes off the hot path for them.
  if (!value.includes('%') && !value.includes('+')) return []

  const seen = new Set([value])
  const out: string[] = []
  let current = value

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = decodeOnce(current)
    if (next === null || seen.has(next)) break
    seen.add(next)
    out.push(next)
    current = next
  }

  // Form encoding writes a space as `+`, and a query string is where an
  // exfiltrated quotation is most likely to end up.
  const plus = value.replace(/\+/gu, ' ')
  if (!seen.has(plus)) {
    seen.add(plus)
    out.push(plus)
    const decoded = decodeOnce(plus)
    if (decoded !== null && !seen.has(decoded)) out.push(decoded)
  }

  return out
}

function decodeOnce(value: string): string | null {
  if (!value.includes('%')) return null
  try {
    const decoded = decodeURIComponent(value)
    return decoded === value ? null : decoded
  } catch {
    // A lone `%` is ordinary text — a discount, a format string — and it is
    // not our business to reject it.
    return null
  }
}
