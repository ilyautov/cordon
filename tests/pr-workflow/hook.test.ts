import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const HOOK = join(process.cwd(), 'scripts/pr-review-hook.mjs')
const SESSION = 'review-session'
const READ_DIFF = 'mcp__pr__read_diff'
const DIFF = 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n+Hello\r\n'

let root: string
let work: string
let cordonHome: string
let log: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cordon-pr-hook-'))
  work = join(root, 'work')
  cordonHome = join(root, 'state')
  log = join(root, 'hooks.jsonl')
  mkdirSync(work, { mode: 0o700 })
  mkdirSync(cordonHome, { mode: 0o700 })
  writeFileSync(join(cordonHome, 'policy.yaml'), [
    'mode: autonomous',
    'profile:',
    '  effects: [read]',
    'tools:',
    '  mcp__pr__read_diff: [read]',
    '  mcp__other__status: [read]',
    'toolsReturn:',
    '  mcp__pr__read_diff: source',
    '',
  ].join('\n'), { mode: 0o600 })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(kind: string, fields: Record<string, unknown>) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: work, encoding: 'utf8',
    env: { CORDON_HOME: cordonHome, CORDON_PR_HOOK_LOG: log },
    input: JSON.stringify({ hook_event_name: kind, session_id: SESSION, cwd: work, ...fields }),
  })
}

function records() {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

describe('PR review hook evidence', () => {
  it('records the same call and session on pre and post, with the literal diff digest on post only', () => {
    const call = { tool_name: READ_DIFF, tool_use_id: 'call-1', tool_input: {} }
    expect(run('UserPromptSubmit', { prompt: 'Review PR #12.' }).status).toBe(0)
    expect(run('PreToolUse', call).status).toBe(0)
    const result = { content: [{ type: 'text', text: DIFF }] }
    expect(run('PostToolUse', { ...call, tool_response: result }).status).toBe(0)
    expect(records()).toEqual([
      { kind: 'UserPromptSubmit', tool: null, toolUseId: null, sessionId: SESSION, status: 0, decision: null },
      { kind: 'PreToolUse', tool: READ_DIFF, toolUseId: 'call-1', sessionId: SESSION, status: 0, decision: null },
      { kind: 'PostToolUse', tool: READ_DIFF, toolUseId: 'call-1', sessionId: SESSION, status: 0, decision: null,
        resultSha256: createHash('sha256').update(DIFF).digest('hex') },
    ])
    expect(readFileSync(log, 'utf8')).not.toContain('Hello')
  })

  it.each(['PreToolUse', 'PostToolUse'])('refuses an unexpected tool in %s even when the core policy allows it', (kind) => {
    const result = run(kind, { tool_name: 'mcp__other__status', tool_use_id: 'call-1', tool_input: {},
      tool_response: { content: [{ type: 'text', text: 'Available.' }] } })
    expect(result.status).toBe(2)
    expect(result.stderr.trim()).not.toBe('')
    expect(records()).not.toContainEqual(expect.objectContaining({ status: 0 }))
  })

  it('refuses a tool event without a call ID', () => {
    const result = run('PreToolUse', { tool_name: READ_DIFF, tool_input: {} })
    expect(result.status).toBe(2)
    expect(records()).not.toContainEqual(expect.objectContaining({ status: 0 }))
  })

  it.each([
    { content: [{ type: 'text', text: 'The service is unavailable.' }], isError: true },
    { content: [{ type: 'text', text: DIFF }, { type: 'text', text: 'More notes.' }] },
    { content: [{ type: 'text', text: '' }] },
  ])('blocks an unexpected result shape without recording a successful read', (tool_response) => {
    const result = run('PostToolUse', { tool_name: READ_DIFF, tool_use_id: 'call-1', tool_input: {}, tool_response })
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'block' })
    expect(records()).not.toContainEqual(expect.objectContaining({ status: 0 }))
  })

  it('records a core post block as unsuccessful and sends its reason to Codex on stderr', () => {
    writeFileSync(join(cordonHome, 'policy.yaml'), 'mode: invalid\n')
    const result = run('PostToolUse', { tool_name: READ_DIFF, tool_use_id: 'call-1', tool_input: {},
      tool_response: { content: [{ type: 'text', text: DIFF }] } })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('withheld')
    expect(records()).toEqual([{ kind: 'PostToolUse', tool: READ_DIFF, toolUseId: 'call-1',
      sessionId: SESSION, status: 2, decision: 'block' }])
  })

  it('records a core denial as unsuccessful', () => {
    const result = run('PreToolUse', { tool_name: 'mcp__pr__propose_merge', tool_use_id: 'call-2',
      tool_input: { pr: 12 } })
    expect(result.status).toBe(2)
    expect(records()).toEqual([{ kind: 'PreToolUse', tool: 'mcp__pr__propose_merge', toolUseId: 'call-2',
      sessionId: SESSION, status: 2, decision: 'deny' }])
  })
})
