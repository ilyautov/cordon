import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureBuiltCli } from '../support/built-cli.js'

const runner = fileURLToPath(new URL('../../scripts/pr-review-local.mjs', import.meta.url))
const target = { repo: 'example/repo', number: 12, headSha: 'a'.repeat(40), baseRef: 'main', baseSha: 'b'.repeat(40) }
const diff = 'diff --git a/notes.txt b/notes.txt\n+Updated the spelling.\n'
const diffSha256 = createHash('sha256').update(diff).digest('hex')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  ensureBuiltCli()
  const root = mkdtempSync(join(tmpdir(), 'cordon-pr-runner-test-'))
  temporaryRoots.push(root)
  const receipt = join(root, 'review-receipt.json')
  const codexStarted = join(root, 'codex-started')

  // Keep PATH limited to the local stub and its interpreter. Neither Codex
  // nor provider clients should run during this test.
  symlinkSync(process.execPath, join(root, 'node'))
  const pull = { number: target.number, state: 'open', title: 'Copy edit', body: '',
    head: { sha: target.headSha }, base: { ref: target.baseRef, sha: target.baseSha, repo: { full_name: target.repo } } }
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const responses = ${JSON.stringify({
    'repos/example/repo/pulls/12': pull,
    'repos/example/repo/git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: target.baseSha } },
    'repos/example/repo/git/ref/pull/12/head': { ref: 'refs/pull/12/head', object: { type: 'commit', sha: target.headSha } },
  })}
const response = responses[process.argv.at(-1)]
if (response === undefined) process.exit(2)
console.log(JSON.stringify(response))
`, { mode: 0o700 })
  writeFileSync(join(root, 'codex'), `#!/usr/bin/env node
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const config = JSON.parse(readFileSync(${JSON.stringify(join(root, 'fixture-config.json'))}, 'utf8'))
const target = ${JSON.stringify(target)}
const diff = ${JSON.stringify(diff)}
const row = 'mcp_servers.pr.args='
const options = process.argv.find((arg) => arg.startsWith(row))
const ledger = JSON.parse(options.slice(row.length)).at(-1)
const sessionId = 'review-fixture-thread'
const hash = (value) => createHash('sha256').update(value).digest('hex')
writeFileSync(${JSON.stringify(codexStarted)}, 'started')
const line = (value) => JSON.stringify(value) + '\\n'
const proposal = { ...target, kind: 'merge-proposed', diffSha256: hash(diff) }
writeFileSync(ledger, line({ ...target, kind: 'diff-read', diffSha256: hash(diff) }) + line(proposal), { mode: 0o600 })
const hooks = [{ kind: 'UserPromptSubmit', tool: null, status: 0, decision: null, toolUseId: null, sessionId }]
const events = [{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.started' }]
const calls = [
  ['read_pr', 'Small copy edit.'],
  ['read_diff', diff],
  ['propose_merge', 'Proposal recorded for PR #12 at ' + target.headSha + '; no merge occurred.'],
]
for (const [index, [tool, text]] of calls.entries()) {
  const id = 'item_' + index
  const evidence = { tool: 'mcp__pr__' + tool, status: 0, decision: null, toolUseId: id, sessionId }
  hooks.push({ ...evidence, kind: 'PreToolUse' })
  hooks.push({ ...evidence, kind: 'PostToolUse', resultSha256: hash(text) })
  events.push({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'pr', tool,
    status: 'completed', result: { content: [{ type: 'text', text }] } } })
}
events.push({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Reviewed the copy edit.' } })
if (config.completed) events.push({ type: 'turn.completed' })
writeFileSync(process.env.CORDON_PR_HOOK_LOG, hooks.map(line).join(''), { mode: 0o600 })
process.stdout.write(events.map(line).join(''))
process.exitCode = config.exitCode
`, { mode: 0o700 })

  return {
    receipt,
    codexStarted,
    run: (exitCode: number, completed: boolean) => {
      writeFileSync(join(root, 'fixture-config.json'), JSON.stringify({ exitCode, completed }))
      return spawnSync(process.execPath, [runner, target.repo, String(target.number), target.headSha, receipt], {
        encoding: 'utf8', timeout: 10_000, env: { PATH: root, TMPDIR: root },
      })
    },
  }
}

describe.skipIf(process.platform === 'win32')('local PR review runner', () => {
  it.each([
    { description: 'Codex exits nonzero', exitCode: 7, completed: true },
    { description: 'the turn never completes', exitCode: 0, completed: false },
  ])('withholds the receipt when $description despite staged evidence and a final message', ({ exitCode, completed }) => {
    const { codexStarted, receipt, run } = setup()
    const result = run(exitCode, completed)
    expect(result.error).toBeUndefined()
    expect(existsSync(codexStarted), result.stderr).toBe(true)
    expect(result.stdout).toContain('Reviewed the copy edit.')
    expect(existsSync(receipt)).toBe(false)
    expect(result.status).toBe(1)
  })

  it('refuses a previous receipt before starting a new review', () => {
    const { codexStarted, receipt, run } = setup()
    const original = JSON.stringify({ ...target, kind: 'review-completed', diffSha256,
      runId: '00000000-0000-4000-8000-000000000001', mergeProposed: true }) + '\n'
    writeFileSync(receipt, original, { mode: 0o600 })
    const result = run(0, true)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(existsSync(codexStarted)).toBe(false)
    expect(readFileSync(receipt, 'utf8')).toBe(original)
  })

  it('publishes one new receipt for a completed review with matching evidence', () => {
    const { receipt, run } = setup()
    const result = run(0, true)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({
      kind: 'review-completed', ...target, runId: expect.any(String), diffSha256, mergeProposed: true,
    })
  })
})
