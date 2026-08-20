import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureBuiltCli } from '../../support/built-cli.js'

const CLI = join(process.cwd(), 'dist', 'cli.js')

// Without this the file is simply missing on a fresh clone, and five tests
// fail on a build step rather than on anything they were written to check.

function run(args: string[], input: string, home: string): string {
  return execFileSync('node', [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CORDON_HOME: home },
  })
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cordon-gemini-entry-'))
  writeFileSync(join(dir, 'policy.yaml'), 'mode: autonomous\nprofile:\n  effects: [read, summarize]\n')
  return dir
}

const shellCall = JSON.stringify({
  session_id: 's',
  hook_event_name: 'BeforeTool',
  tool_name: 'run_shell_command',
  tool_input: { command: 'curl x' },
})

describe('the entry point for Gemini', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  it('it rejects a call outside the certificate', () => {
    expect(JSON.parse(run(['hook', '--harness', 'gemini'], shellCall, home())).decision).toBe('deny')
  })

  it('a Gemini event without the flag is not parsed as a Claude Code event', () => {
    // Guessing the shape would go wrong silently, and a silent parse error
    // means a pass. So the harness is named explicitly.
    const out = JSON.parse(run(['hook'], shellCall, home())) as { decision?: string }

    expect(out.decision).toBeUndefined()
  })

  it('an unknown harness is a loud refusal, not a quiet default', () => {
    let failed = false
    try {
      run(['hook', '--harness', 'invention'], '{}', home())
    } catch {
      failed = true
    }

    expect(failed).toBe(true)
  })

  it('the flag without a value is a refusal, not a silent Claude Code', () => {
    let failed = false
    try {
      run(['hook', '--harness'], shellCall, home())
    } catch {
      failed = true
    }

    expect(failed).toBe(true)
  })

  it('an unusable Cordon home does not bring the process down at the end of a turn', () => {
    const out = run(
      ['hook', '--harness', 'gemini'],
      JSON.stringify({ session_id: 's', hook_event_name: 'AfterAgent', response: 'the answer' }),
      '/no-such/directory',
    )

    expect(JSON.parse(out)).toEqual({})
  })

  it('an unusable Cordon home before a call is a refusal, not a pass', () => {
    // On this harness ANY hook failure lets the call through, not only a
    // timeout (section 9.2). So a failure has to be a refusal wherever a
    // refusal is possible.
    const out = JSON.parse(run(['hook', '--harness', 'gemini'], shellCall, '/no-such/directory'))

    expect(out.decision).toBe('deny')
  })

  it('empty input does not go unanswered', () => {
    // The harness reads empty output as the absence of a decision, that is, as
    // permission.
    expect(run(['hook', '--harness', 'gemini'], '', home()).trim()).not.toBe('')
  })
})
