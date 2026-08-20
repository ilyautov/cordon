import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The compiled entry point the CLI tests start as a separate process. */
export const BUILT_CLI = join(process.cwd(), 'dist', 'cli.js')

/**
 * Builds `dist/` if it is not there, so a fresh clone can run `npm test`.
 *
 * Only the library half of the build, never `bundle`. The bundle at
 * `plugin/dist/cli.js` is committed, and one of the tests checks that it still
 * matches the sources: that check is the only thing standing between a reader
 * and an artifact built from different code. A test that quietly regenerates
 * the bundle first would make that check pass by construction and catch
 * nothing, which is how it behaved until this helper existed.
 */
export function ensureBuiltCli(): void {
  if (existsSync(BUILT_CLI)) return
  execFileSync('npm', ['run', 'build:lib'], { stdio: 'inherit' })
}
