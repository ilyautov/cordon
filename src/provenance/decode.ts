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
  const out = percentDecodings(value)
  for (const text of binaryToText(value)) if (text !== value && !out.includes(text)) out.push(text)
  return out
}

/**
 * Runs of base64 (both alphabets) and hex, decoded when what comes out is
 * text. The battery measured a page asking for its quotation "as base64 in
 * the query" walking past provenance; the detectors for exactly these runs
 * already stood in sanitize, and the gate did not use them.
 *
 * Only text is kept: a commit hash, a random token or an image decodes to
 * bytes that are not text, and matching noise against the store is pure cost.
 */
const BASE64_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/gu
const HEX_RUN = /(?:[0-9a-fA-F]{2}){24,}/gu

function binaryToText(value: string): string[] {
  if (value.length < 32) return []
  const out: string[] = []
  for (const match of value.matchAll(BASE64_RUN)) {
    // A '/' is in the alphabet, so a path segment in front shifts the
    // alignment; each segment is tried on its own as well.
    const candidates = new Set([match[0], ...match[0].split('/').filter((part) => part.length >= 32)])
    for (const candidate of candidates) {
      const text = asText(Buffer.from(candidate.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64'))
      if (text !== null) out.push(text)
    }
  }
  for (const match of value.matchAll(HEX_RUN)) {
    const text = asText(Buffer.from(match[0], 'hex'))
    if (text !== null) out.push(text)
  }
  return out
}

/** The bytes as UTF-8 text, or null when they are not text. */
function asText(bytes: Buffer): string | null {
  if (bytes.length < 16) return null
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD')) return null
  // Controls other than whitespace do not occur in prose.
  if (/[\u0000-\u0008\u000E-\u001F\u007F]/u.test(text)) return null
  const letters = text.match(/[\p{L}\p{N}\s]/gu)?.length ?? 0
  return letters / [...text].length >= 0.7 ? text : null
}

function percentDecodings(value: string): string[] {
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
