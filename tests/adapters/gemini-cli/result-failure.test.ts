import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cordon } from '../../../src/cordon.js'
import { runHook } from '../../../src/adapters/gemini-cli/main.js'

/**
 * The same rule as on the Claude Code adapter: a result the scan broke on is
 * not answered with silence (Codex, reviewing the connectors).
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cordon-gemini-result-failure-'))
  writeFileSync(join(dir, 'policy.yaml'), [
    'mode: autonomous',
    'profile:',
    '  effects: [read, network-egress, create, update]',
    '  resources:',
    '    paths: []',
    '    hosts: []',
    'notify:',
    `  file: ${join(dir, 'events.jsonl')}`,
  ].join('\n'))
  return dir
}

const run = (dir: string, event: Record<string, unknown>) =>
  JSON.parse(runHook(JSON.stringify({ session_id: 'grf1', transcript_path: '', cwd: '/w', ...event }), dir)) as Record<string, any>

afterEach(() => vi.restoreAllMocks())

describe('gemini: a result that breaks the scan', () => {
  it('is withheld, and the calls that act are held', () => {
    const dir = home()
    run(dir, { hook_event_name: 'BeforeAgent', prompt: 'summarize /w/a.txt into /w/out.txt' })
    vi.spyOn(Cordon.prototype, 'observe').mockImplementation(() => { throw new Error('boom') })
    const out = run(dir, { hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: { absolute_path: '/w/a.txt' }, tool_response: { llmContent: 'plain text', error: null } })
    vi.restoreAllMocks()
    expect(out.decision).toBe('deny')
    expect(out.reason).toMatch(/Cordon failure: boom/)
    const next = run(dir, { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/w/out.txt', content: 'x' } })
    expect(next.decision).toBe('deny')
  })

  it('a failure before the core comes up still holds the calls that act', () => {
    const dir = home()
    run(dir, { hook_event_name: 'BeforeAgent', prompt: 'summarize /w/a.txt into /w/out.txt' })
    chmodSync(join(dir, 'policy.yaml'), 0o000)
    const out = run(dir, { hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: { absolute_path: '/w/a.txt' }, tool_response: { llmContent: 'plain text', error: null } })
    chmodSync(join(dir, 'policy.yaml'), 0o600)
    expect(out.decision).toBe('deny')
    const next = run(dir, { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/w/out.txt', content: 'x' } })
    expect(next.decision).toBe('deny')
  })
})
