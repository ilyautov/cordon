// A failed hook would otherwise be treated as permission to continue by Codex.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = join(dirname(fileURLToPath(import.meta.url)), '../plugin/dist/cli.js')
const allowedTools = new Set(['mcp__pr__read_pr', 'mcp__pr__read_diff', 'mcp__pr__propose_merge'])
const hookEvents = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse'])
const failure = 'PR review hook failed'
let kind = 'PreToolUse'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function resultText(value) {
  // Codex serializes its internal CallToolResult for the hook. The fixed PR
  // server returns exactly one text block, with no alternate output channel.
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.length !== 1 ||
    Object.keys(value).some((key) => !['content', 'is_error', 'isError'].includes(key)) ||
    (Object.hasOwn(value, 'is_error') && value.is_error !== false) ||
    (Object.hasOwn(value, 'isError') && value.isError !== false)) {
    throw new Error('unexpected PR tool result')
  }
  const [block] = value.content
  if (!isRecord(block) || Object.keys(block).length !== 2 || block.type !== 'text' || !isNonemptyString(block.text)) {
    throw new Error('unexpected PR tool content')
  }
  return block.text
}

function refuse() {
  const response = kind === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName: kind, permissionDecision: 'deny', permissionDecisionReason: failure } }
    : { decision: 'block', reason: failure }
  process.stdout.write(JSON.stringify(response) + '\n')
  // Codex uses stderr for the reason when an exit-2 hook blocks.
  process.stderr.write(failure + '\n')
  process.exitCode = 2
}

try {
  const input = readFileSync(0, 'utf8')
  const event = JSON.parse(input)
  if (!isRecord(event) || !hookEvents.has(event.hook_event_name)) throw new Error('unexpected hook event')
  kind = event.hook_event_name
  const sessionId = event.session_id
  if (!isNonemptyString(sessionId)) throw new Error('missing hook session')
  const isPrompt = kind === 'UserPromptSubmit'
  const tool = isPrompt ? null : event.tool_name
  const toolUseId = isPrompt ? null : event.tool_use_id
  if (isPrompt ? !isNonemptyString(event.prompt) :
    !allowedTools.has(tool) || !isNonemptyString(toolUseId) || !isRecord(event.tool_input)) {
    throw new Error('invalid PR review event')
  }
  const text = kind === 'PostToolUse' ? resultText(event.tool_response) : null

  const result = spawnSync(process.execPath, [bundle, 'hook', '--harness', 'codex'], {
    input, encoding: 'utf8', timeout: 4_000,
  })
  if (result.error || ![0, 2].includes(result.status)) throw new Error('Cordon hook failed')
  const answer = JSON.parse(result.stdout)
  if (!isRecord(answer)) throw new Error('invalid Cordon hook output')
  const decision = answer.hookSpecificOutput?.permissionDecision ?? answer.decision ?? null
  const postBlocked = kind === 'PostToolUse' && decision === 'block'
  const denied = kind === 'PreToolUse' && result.status === 2 && decision === 'deny'
  if (!postBlocked && !denied && (result.status !== 0 || decision !== null || answer.continue === false)) {
    throw new Error('unexpected Cordon hook decision')
  }

  const status = postBlocked || denied ? 2 : 0
  if (!process.env.CORDON_PR_HOOK_LOG) throw new Error('missing hook evidence path')
  const resultSha256 = status === 0 && text !== null && tool === 'mcp__pr__read_diff'
    ? createHash('sha256').update(text, 'utf8').digest('hex') : undefined
  appendFileSync(process.env.CORDON_PR_HOOK_LOG, JSON.stringify({
    kind, tool, toolUseId, sessionId, status, decision, resultSha256,
  }) + '\n', { mode: 0o600 })
  process.stdout.write(result.stdout)
  if (result.stderr.trim()) process.stderr.write(result.stderr)
  else if (status === 2) process.stderr.write((isNonemptyString(answer.reason) ? answer.reason : failure) + '\n')
  process.exitCode = status
} catch {
  // Refuse a call or withhold its result when validation or auditing fails.
  refuse()
}
