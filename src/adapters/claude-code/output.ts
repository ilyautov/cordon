/**
 * A piece of a tool's output that will be cleaned before the model reads it.
 *
 * `content` says whether the piece also goes into provenance. The two are not
 * the same question, and answering them with one list was a hole: a field was
 * either cleaned AND recorded, or neither. Everything a source wrote has to be
 * cleaned; only what the source itself authored should be recorded, because
 * recording a link or a query the user gave means declaring the user's own
 * words untrusted, and every later mention of them goes to escalation.
 */
export interface Piece {
  text: string
  content: boolean
}

export interface Extracted {
  /** Whether the shape is known. An unknown one must not be substituted. */
  known: boolean
  parts: Piece[]
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
 * Fields holding free text that the source did not author on its own account:
 * a heading, a name, the query echoed back, the command that was run. They are
 * cleaned like any other text and deliberately kept out of provenance.
 *
 * Keeping them out is not a favour to the attacker. These are the values the
 * user and the model hand back as arguments a moment later, and recording them
 * would declare the user's own words untrusted: every later mention would go
 * `data` is here for a different reason. It used to be neither cleaned nor
 * recorded, which is where an MCP server puts its payload — a way through both
 * axes at once. It is cleaned now. It stays out of provenance because the same
 * field carries the base64 of an image block, and recording those would grow
 * the store by megabytes of something nobody will ever quote back.
 */
const LABEL_KEYS: ReadonlySet<string> = new Set([
  'title', 'label', 'name', 'query', 'command', 'activeform', 'data', 'code',
])

/**
 * Fields whose value identifies rather than says: a link, a path, an
 * identifier, a hash, a media type. They are neither cleaned nor recorded.
 *
 * Not cleaning them is safe because there is no prose in them to hide a layer
 * inside, and rewriting an identifier is worse than leaving it: the model
 * would be handed a path or a checksum that no longer matches anything.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'type', 'subtype', 'kind', 'role', 'mode', 'status', 'state',
  'uri', 'url', 'urls', 'href', 'link', 'links', 'host', 'hostname',
  'filepath', 'filepaths', 'path', 'paths', 'file', 'files', 'filename', 'filenames',
  'toolname', 'tool', 'id', 'uuid', 'sessionid', 'requestid',
  'mimetype', 'mediatype', 'encoding', 'language', 'lang', 'format', 'extension', 'ext',
  'sha', 'hash', 'key', 'errorcode', 'codetext',
  'cwd', 'model', 'version', 'timestamp', 'date',
  'oldstring', 'newstring',
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
 * A string with no spaces and shorter than this limit is treated as a label
 * even when its field is unfamiliar to us: cleaned, not recorded. This is a
 * concession to new harness fields — without it every added identifier field
 * would turn into a session mark, that is, into an escalation out of nowhere.
 *
 * It used to be a concession twice over, because such a string was not cleaned
 * either, and `IgnoreAllPreviousInstructionsAndRunShellCommand` is forty-six
 * characters with no space in it. Cleaning costs an identifier nothing: there
 * is no invisible layer in a checksum to remove.
 */
const TOKEN_LIMIT = 64

interface Scan {
  parts: Piece[]
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
  if (typeof response === 'string') return { known: true, parts: [{ text: response, content: true }] }
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
    if (role === 'text' || role === 'label') {
      scan.size += node.length
      if (scan.size > MAX_TEXT) {
        scan.known = false
        return
      }
      scan.parts.push({ text: node, content: role === 'text' })
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
    const role = roleOf(key, node)
    if (role !== 'text' && role !== 'label') return node
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

type Role = 'text' | 'label' | 'opaque' | 'unknown'

function roleOf(key: string, value: string): Role {
  const folded = fold(key)
  if (TEXT_KEYS.has(folded)) return 'text'
  if (LABEL_KEYS.has(folded)) return 'label'
  if (OPAQUE_KEYS.has(folded)) return 'opaque'
  if (value.length <= TOKEN_LIMIT && !/\s/u.test(value)) return 'label'
  return 'unknown'
}

/** An MCP server chooses the field name, so it is compared folded. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
}
