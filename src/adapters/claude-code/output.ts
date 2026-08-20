export interface Extracted {
  /** Whether the shape is known. An unknown one must not be substituted. */
  known: boolean
  parts: string[]
}

/**
 * Tools whose output retells what the model itself wrote: a written file, an
 * edit, a task list. There is nothing to clean there, and recording the
 * model's own text into provenance would mean declaring its own intent
 * untrusted.
 */
const TEXTLESS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', 'TodoWrite'])

/**
 * The fields holding free text, that is, the very thing the model will read
 * as content. Only they are cleaned and go into provenance.
 */
const TEXT_KEYS: ReadonlySet<string> = new Set([
  'text', 'stdout', 'stderr', 'content', 'result', 'output',
  'message', 'description', 'body', 'error',
])

/**
 * Fields whose value is a label, a path, a link or another structural
 * identifier. They are not cleaned and do not go into provenance.
 *
 * The second matters more than the first. Recording a WebFetch result's `url`
 * into provenance means declaring untrusted a link the user gave themselves:
 * any later mention of that link would go to escalation. False taint from
 * structural fields breaks the work more quietly and more surely than a miss.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'type', 'subtype', 'kind', 'role', 'mode', 'status', 'state',
  'uri', 'url', 'urls', 'href', 'link', 'links', 'host', 'hostname',
  'filepath', 'filepaths', 'path', 'paths', 'file', 'files', 'filename', 'filenames',
  'name', 'toolname', 'tool', 'title', 'label', 'id', 'uuid', 'sessionid', 'requestid',
  'mimetype', 'mediatype', 'encoding', 'language', 'lang', 'format', 'extension', 'ext',
  'data', 'sha', 'hash', 'key', 'code', 'codetext', 'errorcode',
  'query', 'command', 'cwd', 'model', 'version', 'timestamp', 'date',
  'activeform', 'oldstring', 'newstring',
])

/**
 * Traversal limits. Exceeding one means an unknown shape rather than a
 * truncated traversal: an unexamined piece means text the model will read and
 * we will not see. The depth limit also closes off output assembled out of a
 * thousand nestings.
 */
const MAX_DEPTH = 12
const MAX_NODES = 20_000
const MAX_TEXT = 8_000_000

/**
 * A string with no spaces and shorter than this limit counts as structural,
 * even when its field is unfamiliar to us. This is a concession to new
 * harness fields: without it every added identifier field would turn into a
 * session mark, that is, into an escalation out of nowhere. The price is
 * declared: an instruction that fits into 64 characters without a single
 * space passes under this rule.
 */
const TOKEN_LIMIT = 64

interface Scan {
  parts: string[]
  known: boolean
  nodes: number
  size: number
}

/**
 * Pulls the text pieces out of a tool's output, remembering the shape.
 *
 * The shape matters literally: the harness silently discards a substitution
 * whose shape does not match the original and shows the model the source
 * text. A quiet fallback to the poisoned original is worse than an explicit
 * refusal, so an unfamiliar shape is marked and not substituted at all.
 *
 * Knownness is computed from the strings rather than from the tool name: an
 * MCP tool chooses its shape itself, and its name tells us nothing. A shape
 * is known when every string inside it is either parsed as free text or
 * recognized as structural. A string whose role we do not understand makes
 * the whole shape unknown: that is exactly the text the model will read
 * uncleaned.
 */
export function extractText(tool: string, response: unknown): Extracted {
  if (typeof response === 'string') return { known: true, parts: [response] }
  if (TEXTLESS.has(tool)) return { known: true, parts: [] }

  const scan: Scan = { parts: [], known: true, nodes: 0, size: 0 }
  visit(response, '', 0, scan)
  return scan.known ? { known: true, parts: scan.parts } : { known: false, parts: [] }
}

/**
 * Puts the cleaned pieces back, preserving the shape down to the last field.
 *
 * The number of pieces must match the number of slots: a mismatch means the
 * caller analysed the output with a different pass, and substituting by it is
 * not allowed. The original value is returned, that is, no substitution
 * happens at all.
 */
export function replaceText(tool: string, response: unknown, parts: string[]): unknown {
  const found = extractText(tool, response)
  if (!found.known || found.parts.length !== parts.length) return response
  if (typeof response === 'string') return parts[0] ?? response
  if (TEXTLESS.has(tool)) return response

  return rebuild(response, '', 0, parts, { at: 0 })
}

function visit(node: unknown, key: string, depth: number, scan: Scan): void {
  if (!scan.known) return
  if (depth > MAX_DEPTH || ++scan.nodes > MAX_NODES) {
    scan.known = false
    return
  }

  if (typeof node === 'string') {
    const role = roleOf(key, node)
    if (role === 'unknown') {
      scan.known = false
      return
    }
    if (role === 'text') {
      scan.size += node.length
      if (scan.size > MAX_TEXT) {
        scan.known = false
        return
      }
      scan.parts.push(node)
    }
    return
  }

  if (Array.isArray(node)) {
    // An array element inherits its field's name: `content: ['review']` is
    // the same review as `content: 'review'`.
    for (const item of node) visit(item, key, depth + 1, scan)
    return
  }

  if (typeof node === 'object' && node !== null) {
    for (const [name, value] of Object.entries(node)) visit(value, name, depth + 1, scan)
  }

  // A number, a boolean, null and an absent value carry no text and cannot
  // hide a layer inside themselves.
}

function rebuild(
  node: unknown,
  key: string,
  depth: number,
  parts: readonly string[],
  cursor: { at: number },
): unknown {
  if (typeof node === 'string') {
    if (roleOf(key, node) !== 'text') return node
    const next = parts[cursor.at++]
    return next ?? node
  }

  if (Array.isArray(node)) {
    return node.map((item) => rebuild(item, key, depth + 1, parts, cursor))
  }

  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(node)) {
      // The field name came from the tool's output, that is, from outside:
      // assignment through `__proto__` would replace the prototype rather
      // than create a field.
      Object.defineProperty(out, name, {
        value: rebuild(value, name, depth + 1, parts, cursor),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    return out
  }

  return node
}

type Role = 'text' | 'structural' | 'unknown'

function roleOf(key: string, value: string): Role {
  const folded = fold(key)
  if (TEXT_KEYS.has(folded)) return 'text'
  if (STRUCTURAL_KEYS.has(folded)) return 'structural'
  if (value.length <= TOKEN_LIMIT && !/\s/u.test(value)) return 'structural'
  return 'unknown'
}

/** An MCP server chooses the field name, so it is compared folded. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
}
