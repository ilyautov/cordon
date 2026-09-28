import { cordonHome, runHook as runClaudeFormatHook } from '../claude-code/main.js'
import { KIMI } from '../claude-code/dialect.js'

/**
 * Kimi Code speaks Claude Code's hook format, so its events go through the
 * same adapter; what Kimi does differently is in the dialect.
 */
export function runHook(stdin: string, home: string = cordonHome()): string {
  return runClaudeFormatHook(stdin, home, KIMI)
}
