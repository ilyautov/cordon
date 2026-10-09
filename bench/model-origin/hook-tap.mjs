// The live benchmark records only hook event and tool names. It delegates
// each complete event to the committed Cordon bundle without altering it.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

let kind = null
const refuse = () => {
  process.stdout.write(JSON.stringify(kind === 'PostToolUse'
    ? { decision: 'block', reason: 'benchmark hook failed before Cordon returned a decision' }
    : { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'benchmark hook failed before Cordon returned a decision',
    } }))
  process.exitCode = 2
}

try {
  const input = readFileSync(0, 'utf8')
  const event = JSON.parse(input)
  kind = event.hook_event_name
  const result = spawnSync(process.execPath, [process.argv[2], 'hook', '--harness', 'codex'], {
    input, encoding: 'utf8', timeout: 4_000,
  })
  const answer = JSON.parse(result.stdout ?? '')
  const decision = answer?.hookSpecificOutput?.permissionDecision ?? answer?.decision ?? null
  if (result.error || ![0, 2].includes(result.status) || typeof answer !== 'object' || answer === null ||
    Array.isArray(answer) || (result.status === 2 && !['deny', 'block'].includes(decision))) {
    refuse()
  } else {
    appendFileSync(process.env.CORDON_HOOK_TAP_LOG, JSON.stringify({
      kind, tool: event.tool_name ?? null, status: result.status,
      decision,
    }) + '\n')
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.status
  }
} catch {
  refuse()
}
