import { atoms } from '../provenance/normalize.js'

export interface QuarantineResult {
  possible: boolean
  args: Record<string, unknown>
  removed: string[]
  reason: string
}

/**
 * Arguments whose value is indivisible: a truncated value is not the same
 * call in a safe form, it is a different call.
 *
 * A shell command with a piece missing is still an executable command, just a
 * different one: `rm -rf /home/u/tmp` without "home/u/" is `rm -rf /tmp`. A
 * path without a segment points at a different file. A link without its host
 * leads somewhere else. These cases are also caught by the identity check
 * below, but the argument name is known in advance, and refusing on it is
 * more honest than hoping the value parses.
 */
const INDIVISIBLE: ReadonlySet<string> = new Set([
  'command', 'cmd', 'script', 'shell', 'code',
  'url', 'uri', 'href', 'link', 'endpoint',
  'path', 'filepath', 'notebookpath', 'targetpath', 'destination', 'dest', 'outputpath',
])

/**
 * The share of a value beyond which quarantine stops being quarantine.
 *
 * Excision is meant to remove an inserted piece. When almost the whole value
 * goes, what is left is not the same call in a safe form but a corrupted
 * document, and writing it is worse than asking or refusing: the argument
 * edit is not shown to the human, so no trace remains.
 *
 * The two-thirds threshold is measured rather than eyeballed: legitimate
 * excisions in the pinned cases reach half of a value (an inserted phrase in
 * a short reply), while document corruption during a file write starts around
 * eighty percent. Two thirds separates them with margin on both sides.
 *
 * This is a backstop, not a solution. A document with less than two thirds
 * cut out is corrupted all the same. The solution is not to cut at all when
 * the content is returning to its own source.
 */
const MAX_CUT_SHARE = 2 / 3

/**
 * How many characters must go before the share means anything at all.
 *
 * The share alone is not enough. In a reply to a review an insertion
 * legitimately takes up three quarters of the value, and refusing there means
 * stopping work for nothing. Destroying a document differs not in share but
 * in volume: hundreds of characters and more leave the file. The two
 * conditions together separate the cases; neither separates them alone.
 */
const MAX_CUT_CHARS = 300

/** The MCP server chooses the argument name: `file_path`, `filePath` and `FILE-PATH` are the same thing. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
}

/** Assignment bypassing the `__proto__` setter: the key name comes from outside. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * Cuts fragments that came from an untrusted source out of string arguments.
 *
 * Quarantine is impossible in four cases, and all four mean escalation per
 * the matrix rather than "let the truncated version through":
 *
 * 1. The value became empty. A required argument that turned empty is a
 *    different call, not the same one in a safe form.
 * 2. The value is indivisible by its role: a command, a path, a link.
 * 3. The excision glued together an identity that was not there before. A
 *    truncated link points at a different host, a truncated path at a
 *    different file, and letting that through is worse than refusing. An
 *    identity disappearing, on the contrary, is normal: that is exactly what
 *    quarantine was called for.
 * 4. Most of the value would go. Then this is not the excision of an
 *    insertion but a rewrite of the document, and silently writing the stub
 *    is the worst outcome: the argument edit is not shown to the human.
 */
export function quarantine(
  args: Record<string, unknown>,
  spansByArg: Record<string, Array<[number, number]>>,
): QuarantineResult {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) put(cleaned, key, value)
  const removed: string[] = []

  const refuse = (reason: string): QuarantineResult => ({ possible: false, args, removed: [], reason })

  for (const [name, spans] of Object.entries(spansByArg)) {
    if (!Array.isArray(spans)) return refuse(`the spans of argument ${name} did not arrive as a list`)
    if (spans.length === 0) continue

    // The argument name came from outside, and the object is not indexed by
    // it directly: `args['toString']` would return a function from the
    // prototype and lead the analysis astray, and `args['__proto__']` would
    // lead into the result's prototype.
    if (!Object.hasOwn(args, name)) return refuse(`argument ${name} is absent from the call`)
    const value = args[name]

    if (typeof value !== 'string') {
      return refuse(`argument ${name} is not a string, there is nothing to cut`)
    }
    if (INDIVISIBLE.has(fold(name))) {
      return refuse(`argument ${name} is indivisible: a truncated value is a different call`)
    }
    if (!valid(spans, value.length)) {
      return refuse(`the spans of argument ${name} do not fit inside the value`)
    }

    const next = cut(value, spans)
    if (next.trim().length === 0 && value.trim().length > 0) {
      return refuse(`argument ${name} became empty after the excision`)
    }
    if (introducesIdentity(value, next)) {
      return refuse(`argument ${name} would change its addressee`)
    }
    const lost = value.length - next.length
    if (lost > MAX_CUT_CHARS && lost > value.length * MAX_CUT_SHARE) {
      return refuse(`most of argument ${name} would go; that is no longer the excision of an insertion`)
    }

    put(cleaned, name, next)
    removed.push(name)
  }

  return { possible: true, args: cleaned, removed, reason: '' }
}

/**
 * The spans come from provenance but are validated as foreign: a boundary
 * that slipped cuts the wrong piece and leaves the injection in place.
 */
function valid(spans: Array<[number, number]>, length: number): boolean {
  return spans.every((span) => {
    if (!Array.isArray(span) || span.length !== 2) return false
    const [start, end] = span
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false
    return start >= 0 && end >= start && end <= length
  })
}

function cut(value: string, spans: Array<[number, number]>): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let result = ''
  let cursor = 0
  for (const [start, end] of sorted) {
    if (start > cursor) result += value.slice(cursor, start)
    cursor = Math.max(cursor, end)
  }
  result += value.slice(cursor)
  // Only spaces at the seams are collapsed. A blanket `\s+` replacement
  // would eat newlines, and with them the draft's structure: quarantine must
  // remove somebody else's piece, not reformat the document.
  return result.replace(/[^\S\r\n]{2,}/gu, ' ').trim()
}

/**
 * Whether the excision produced an identity that was not in the original
 * value. An identity that disappeared is not a violation.
 */
function introducesIdentity(before: string, after: string): boolean {
  const was = new Set(atoms(before))
  return atoms(after).some((atom) => !was.has(atom))
}
