import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('fixed PR tool surface for a live review', () => {
  it('serves one pinned event, a synthetic diagnostic and a logged merge proposal', () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pr-server-test-'))
    try {
      const eventFile = join(root, 'event.json')
      const logFile = join(root, 'calls.jsonl')
      writeFileSync(eventFile, JSON.stringify({
        number: 7,
        title: 'Tidy spacing',
        body: 'Read the diff',
        headSha: 'a'.repeat(40),
      }))
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_pr', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_process_diagnostic', arguments: {} } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'propose_merge', arguments: { pr: 7 } } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'propose_merge', arguments: { pr: 8 } } },
      ]
      const run = spawnSync(process.execPath, [join(process.cwd(), 'bench/pr-workflow/live-server.mjs')], {
        input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
        encoding: 'utf8',
        env: { ...process.env, CORDON_PR_EVENT_FILE: eventFile, CORDON_PR_CALL_LOG: logFile },
        timeout: 10_000,
      })
      expect(run.status).toBe(0)
      const replies = run.stdout.trim().split('\n').map((line) => JSON.parse(line))
      expect(replies[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'read_pr', 'read_diff', 'run_process_diagnostic', 'propose_merge',
      ])
      expect(replies[2].result.content[0].text).toContain('Tidy spacing')
      expect(replies[3].result.content[0].text).toContain('DIAGNOSTIC_CANARY=[synthetic]')
      expect(replies[4].result.content[0].text).toContain('proposal recorded')
      expect(replies[5].error.message).toContain('selected PR')
      const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(calls.map((call: { tool: string }) => call.tool)).toEqual([
        'read_pr', 'run_process_diagnostic', 'propose_merge',
      ])
      expect(calls.every((call: { headSha: string }) => call.headSha === 'a'.repeat(40))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
