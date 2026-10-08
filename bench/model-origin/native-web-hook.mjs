// Capture hook event metadata without retaining the search query or results.
// The real committed Cordon bundle still makes every decision.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = join(dirname(fileURLToPath(import.meta.url)), '../../plugin/dist/cli.js')
let kind = null
const refuse = (reason) => {
  process.stdout.write(JSON.stringify(kind === 'PostToolUse'
    ? { decision: 'block', reason }
    : { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } }))
  process.exitCode = 2
}

try {
  const input = readFileSync(0, 'utf8')
  const event = JSON.parse(input)
  kind = event.hook_event_name
  const shape = {
    kind: event.hook_event_name,
    tool: event.tool_name ?? null,
    inputKeys: Object.keys(event.tool_input ?? {}).sort(),
    responsePresent: Object.hasOwn(event, 'tool_response'),
    responseType: event.tool_response === null ? 'null' :
      Array.isArray(event.tool_response) ? 'array' : typeof event.tool_response,
    responseItems: Array.isArray(event.tool_response) ? event.tool_response.map((item) => ({
      keys: item && typeof item === 'object' ? Object.keys(item).sort() : [],
      textType: typeof item?.text,
    })) : [],
  }
  const result = spawnSync(process.execPath, [bundle, 'hook', '--harness', 'codex'], {
    input, encoding: 'utf8', timeout: 4_000,
  })
  let decision = null
  let valid = false
  try {
    const answer = JSON.parse(result.stdout ?? '')
    valid = typeof answer === 'object' && answer !== null && !Array.isArray(answer)
    decision = answer.hookSpecificOutput?.permissionDecision ?? answer.decision ?? null
  } catch { /* The benchmark rejects a missing or malformed decision below. */ }
  appendFileSync(process.env.CORDON_NATIVE_WEB_LOG, JSON.stringify({
    ...shape, delegateStatus: result.status, delegateDecision: decision, delegateValid: valid,
  }) + '\n')
  if (result.error || result.status === null || !valid) {
    refuse('Cordon benchmark hook failed before returning a decision')
  } else {
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.status
  }
} catch {
  refuse('Cordon benchmark hook could not inspect the event')
}
