import { readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Paths that are never writable, whatever the certificate says.
 *
 * Without this rule the very first injection says "edit the settings and
 * switch the hook off", and there is nothing left to check. A defence that
 * can be talked into removing itself is not a defence.
 */
// Kimi Code keeps its hooks in .kimi-code (.kimi before 2.0), DeepSeek
// Harness in .dsh: each holds the line that wires Cordon in.
const HARNESS_CONFIG = ['.claude', '.cursor', '.codex', '.gemini', '.kimi-code', '.kimi', '.dsh', '.config' + sep + 'cordon']

const HARNESS_SEGMENTS: readonly (readonly string[])[] = HARNESS_CONFIG.map((marker) =>
  marker.split(sep).map(fold),
)

/**
 * Names are compared case-folded and stripped of trailing dots and spaces: on
 * macOS and Windows ".CORDON", ".claude." and ".claude " open exactly the
 * same file as the canonical name. On Linux this adds one spurious refusal
 * for a directory with an odd name — a false positive here is cheaper than a
 * miss.
 */
export function fold(segment: string): string {
  return segment.toLowerCase().replace(/[. ]+$/, '')
}

/** The shell expands a tilde, but the harness may hand over an unexpanded path. */
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~' + sep) || path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * A path with its symbolic links resolved.
 *
 * The file may not exist yet: writing it is what creates it. So links are
 * resolved on the existing part of the path, and the non-existent remainder
 * is appended back. A dangling link — one whose target has not been created
 * yet — is handled separately: writing through it creates the file exactly
 * where it points, and realpath does not resolve such a link.
 */
function withoutSymlinks(path: string, hops = 0): string {
  if (hops > 32) return path // a suspected link cycle: we go no further

  try {
    return realpathSync(path)
  } catch {
    // The file is missing or the link is dangling. Both cases are handled below.
  }

  try {
    const link = readlinkSync(path)
    return withoutSymlinks(resolve(dirname(path), link), hops + 1)
  } catch {
    // This is not a link, just a file that has not been created yet.
  }

  const parent = dirname(path)
  if (parent === path) return path
  return join(withoutSymlinks(parent, hops), basename(path))
}

function isInside(path: string, home: string): boolean {
  const foldedPath = path.split(sep).map(fold)
  const foldedHome = home.split(sep).map(fold)
  if (foldedPath.length < foldedHome.length) return false
  return foldedHome.every((segment, index) => segment === foldedPath[index])
}

function hitsHarnessConfig(path: string): boolean {
  const segments = path.split(sep).map(fold)
  return HARNESS_SEGMENTS.some((marker) =>
    segments.some((_, start) => marker.every((part, offset) => part === segments[start + offset])),
  )
}

/**
 * Every version of a path that actually names the same place: the lexical one
 * and the one with symbolic links resolved.
 *
 * Exported because the gate is busy with the same question when it checks
 * resource bounds, and a second copy of this logic would diverge from the
 * first at the very first fix. The function itself decides nothing: the
 * caller decides.
 */
export function canonicalForms(target: string): string[] {
  const expanded = expandTilde(target)
  const path = resolve(expanded)
  // On Windows the walk would start at the root and drop the drive letter,
  // and a garbage form only over-refuses bounds (Kimi): it is skipped there.
  const walked = sep === '/' ? [physical(expanded)] : []
  return [...new Set([path, withoutSymlinks(path), ...walked])]
}

/**
 * The path the way the system walks it: one segment at a time, following a
 * link before the `..` after it is applied. `resolve` drops `link/..`
 * lexically, so a link into .cordon/sessions followed by `../policy.yaml`
 * read as a harmless file beside the link (Codex, reviewing the connectors).
 */
function physical(target: string, hops = 0): string {
  let current = isAbsolute(target) ? sep : process.cwd()
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    let link: string | null = null
    try {
      link = readlinkSync(next)
    } catch {
      // Not a link, or not there yet: the segment is taken as written.
    }
    // A link's own text is walked the same way, not joined: join would drop
    // its `..` lexically too. Past a suspected cycle the lexical step is
    // kept, and the other forms still stand beside this one.
    current = link !== null && hops < 32 ? physical(isAbsolute(link) ? link : `${current}${sep}${link}`, hops + 1) : next
    if (link !== null) hops += 1
  }
  return current
}

/**
 * Answers the question "does this path lead to Cordon itself or to the
 * harness config".
 *
 * Both versions of the path are checked: the lexical one and the one with
 * symbolic links resolved. A link to Cordon's home is not exotic, it is one
 * of the first tricks an injection will come up with.
 */
export function touchesCordonItself(target: string, cordonHome: string): boolean {
  const homes = canonicalForms(cordonHome)
  const paths = canonicalForms(target)

  for (const candidate of paths) {
    if (hitsHarnessConfig(candidate)) return true
    for (const root of homes) {
      if (isInside(candidate, root)) return true
    }
  }
  return false
}
