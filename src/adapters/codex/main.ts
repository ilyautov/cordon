import { cordonHome, runHook as runClaudeFormatHook } from '../claude-code/main.js'
import { CODEX } from '../claude-code/dialect.js'

/**
 * Codex CLI speaks Claude Code's hook format, so its events go through the
 * same adapter; what Codex does differently is in the dialect.
 */
export function runHook(stdin: string, home: string = cordonHome()): string {
  return runClaudeFormatHook(stdin, home, CODEX)
}
