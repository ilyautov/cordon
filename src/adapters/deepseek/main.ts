import { cordonHome, runHook as runClaudeFormatHook } from '../claude-code/main.js'
import { DEEPSEEK } from '../claude-code/dialect.js'

/**
 * DeepSeek Harness runs Claude Code hooks through its bridge, so its events go through the
 * same adapter; what the bridge does differently is in the dialect.
 */
export function runHook(stdin: string, home: string = cordonHome()): string {
  return runClaudeFormatHook(stdin, home, DEEPSEEK)
}
