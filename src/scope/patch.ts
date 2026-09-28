/**
 * What a Codex patch touches, read from its text.
 *
 * Codex writes, moves and deletes files with one tool, apply_patch, and the
 * paths are directive lines inside the patch rather than fields of the call.
 * A gate that reads fields would see no path at all: self-protection, path
 * bounds and the agent's own settings would be walked past by a patch.
 *
 * The lines are read the way Codex 0.157 reads them
 * (codex-rs/apply-patch/src/streaming_parser.rs), because a header Codex
 * sees and this reader does not is a write the gate never saw:
 *
 *   - a line ends at `\n`, and a trailing `\r` is dropped;
 *   - inside an Update File section a header is read after trimming the end
 *     only, so an indented one is a context line of the document;
 *   - everywhere else a header is read after trimming both ends with Rust's
 *     `trim()`, which takes Unicode white space away, U+0085 included, where
 *     `\s` in JavaScript does not (Codex, reviewing this reader).
 *
 * Beyond that it reads wider than Codex, never narrower: any case, loose
 * spacing around the words, a Move to anywhere in an update. A path read that
 * Codex does not write only makes the decision stricter. The path itself is
 * the exception: loosened, it names a different file than the one Codex
 * writes (Codex keeps a U+FEFF that `\s` trims, and spaces after the
 * marker), so where the two differ both are returned and both are checked.
 */

export interface PatchTargets {
  paths: string[]
  /** Whether the patch deletes a file, or moves one, which deletes the old path. */
  deletes: boolean
}

/** Rust's White_Space, exactly what `trim()` removes. */
const RUST_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]'
/** Wider, for finding a header: `\s` adds U+FEFF on top of Rust's set. */
const LOOSE_SPACE = '[\\s\\u0085]'
const trimmer = (space: string) => ({
  leading: new RegExp(`^${space}+`, 'u'),
  trailing: new RegExp(`${space}+$`, 'u'),
})
const RUST = trimmer(RUST_SPACE)
const LOOSE = trimmer(LOOSE_SPACE)

// The `s` flag: without it `.` stops at U+2028, U+2029 and a lone \r, which
// Codex keeps inside a path, and the header was not read at all (Codex,
// reviewing this reader).
const FILE = /^\*\*\*\s*(add|update|delete)\s+file\s*:\s*(.*)$/isu
const MOVE = /^\*\*\*\s*move\s+to\s*:\s*(.*)$/isu
const END = /^\*\*\*\s*end\s+patch$/iu

/** Codex's own markers, after which it takes the rest of the line as the path. */
const MARKERS = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ']

/** The files a patch names, or null for a text that names none. */
export function readPatch(text: string): PatchTargets | null {
  const paths: string[] = []
  let deletes = false
  let updating = false
  const add = (exact: string, loose: string) => {
    for (const path of new Set([exact, loose])) if (path !== '') paths.push(path)
  }
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const cut = (space: { leading: RegExp, trailing: RegExp }) => {
      const end = line.replace(space.trailing, '')
      return updating ? end : end.replace(space.leading, '')
    }
    const exact = cut(RUST)
    const header = cut(LOOSE)
    const written = exactPath(exact)
    const file = FILE.exec(header)
    if (file !== null) {
      const kind = file[1]!.toLowerCase()
      add(written, file[2]!)
      if (kind === 'delete') deletes = true
      updating = kind === 'update'
      continue
    }
    const move = MOVE.exec(header)
    if (updating && move !== null) {
      add(written, move[1]!)
      deletes = true
      continue
    }
    if (END.test(header)) updating = false
  }
  return paths.length === 0 ? null : { paths, deletes }
}

/** The path as Codex takes it: the rest of its trimmed line after its marker. */
function exactPath(line: string): string {
  const marker = MARKERS.find((m) => line.startsWith(m))
  return marker === undefined ? '' : line.slice(marker.length)
}
