// Capture hook metadata without retaining search text. One explicitly marked
// benchmark arm substitutes a PostToolUse block to test Codex's result channel;
// every other decision comes from the committed Cordon bundle.
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
  const syntheticBlock = process.env.CORDON_NATIVE_WEB_POST_BLOCK === '1' &&
    kind === 'PostToolUse' && event.tool_name === 'webrun'
  const result = syntheticBlock
    ? { status: 0, stdout: JSON.stringify({ decision: 'block',
      reason: 'CORDON_WEB_POST_BLOCK_CANARY. The web result was withheld by the benchmark hook.' }), stderr: '' }
    : spawnSync(process.execPath, [bundle, 'hook', '--harness', 'codex'], {
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
    decisionOrigin: syntheticBlock ? 'benchmark' : 'cordon',
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
