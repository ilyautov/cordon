// A failed hook would otherwise be treated as permission to continue by Codex.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = join(dirname(fileURLToPath(import.meta.url)), '../plugin/dist/cli.js')
let kind = 'PreToolUse'
function refuse() {
  const response = kind === 'PostToolUse'
    ? { decision: 'block', reason: 'PR review hook failed' }
    : { hookSpecificOutput: { hookEventName: kind, permissionDecision: 'deny',
      permissionDecisionReason: 'PR review hook failed' } }
  process.stdout.write(JSON.stringify(response))
  process.exitCode = 2
}

try {
  const input = readFileSync(0, 'utf8')
  const event = JSON.parse(input)
  kind = event?.hook_event_name ?? kind
  const result = spawnSync(process.execPath, [bundle, 'hook', '--harness', 'codex'], {
    input, encoding: 'utf8', timeout: 4_000,
  })
  const answer = JSON.parse(result.stdout ?? '')
  const decision = answer?.hookSpecificOutput?.permissionDecision ?? answer?.decision ?? null
  if (result.error || ![0, 2].includes(result.status) ||
    typeof answer !== 'object' || answer === null || Array.isArray(answer) ||
    (result.status === 2 && !['deny', 'block'].includes(decision))) refuse()
  else {
    if (!process.env.CORDON_PR_HOOK_LOG) throw new Error('missing hook evidence path')
    appendFileSync(process.env.CORDON_PR_HOOK_LOG, JSON.stringify({
      kind, tool: typeof event?.tool_name === 'string' ? event.tool_name : null,
      status: result.status, decision,
    }) + '\n', { mode: 0o600 })
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.status
  }
} catch {
  refuse()
}
