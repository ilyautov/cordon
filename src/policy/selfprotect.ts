import { readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Paths that are never writable, whatever the certificate says.
 *
 * Without this rule the very first injection says "edit the settings and
 * switch the hook off", and there is nothing left to check. See §7 of the
 * spec, rule 1.
 */
const HARNESS_CONFIG = ['.claude', '.cursor', '.codex', '.gemini', '.config' + sep + 'cordon']

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
function fold(segment: string): string {
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
  const path = resolve(expandTilde(target))
  return [...new Set([path, withoutSymlinks(path)])]
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
