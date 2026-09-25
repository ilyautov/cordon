import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * Why this home cannot be trusted, or null.
 *
 * The policy is read only from Cordon's home so that a repository cannot bring
 * its own. The home itself comes from CORDON_HOME, though, and Claude Code
 * hands a project's `env` setting to hook processes — verified live. A cloned
 * repository could point CORDON_HOME at a directory of its own with a
 * permissive policy, and the defence would switch itself off with every check
 * reporting green. A home inside the project directory is refused.
 *
 * A session started in the user's home directory (or above it) has that as
 * its project, and every home Cordon could use lies inside it; that is not a
 * project supplying anything, so it is let through.
 */
export function homeProblem(home: string, projectDir: string, userHome: string = homedir()): string | null {
  const project = real(projectDir)
  const user = real(userHome)
  if (inside(user, project)) return null
  const resolved = real(home)
  if (!inside(resolved, project)) return null
  return `Cordon's home ${home} lies inside the project ${projectDir}: a repository could supply its own policy ` +
    'that way (a project setting can set CORDON_HOME). Point CORDON_HOME outside the project'
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The real path, through links, of the nearest part that exists. A home not
 * created yet still resolves: its parent's links are what decide where it
 * would land.
 */
function real(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return resolve(real(parent), relative(parent, absolute))
  }
}

/** The session's project directory as the harness names it to its hooks, or the working directory. */
export function projectDir(): string {
  return process.env['CLAUDE_PROJECT_DIR'] ?? process.env['GEMINI_PROJECT_DIR'] ?? process.cwd()
}
