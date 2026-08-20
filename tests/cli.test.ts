import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'cli.js')

/** A zero-width marker. Escape only: a literal is invisible during review. */
const ZWSP = '\u200B'

function run(
  args: string[],
  input?: string,
  env?: Record<string, string>,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      input: input ?? '',
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { stdout, status: 0 }
  } catch (error) {
    const err = error as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', status: err.status ?? 1 }
  }
}

describe('cordon scan', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
  }, 60_000)

  it('reads a file and prints the findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cordon-'))
    const file = join(dir, 'page.html')
    writeFileSync(file, '<div style="display:none">hidden instruction</div>')

    const { stdout, status } = run(['scan', file])
    expect(status).toBe(0)
    expect(stdout).toContain('hidden-html')
    expect(stdout).toContain('hidden instruction')
  })

  it('reads from standard input', () => {
    const { stdout } = run(['scan', '-'], `hel${ZWSP}lo`)
    expect(stdout).toContain('invisible')
  })

  it('prints JSON with the --json flag', () => {
    const { stdout } = run(['scan', '-', '--json'], '<!-- hidden -->')
    const parsed = JSON.parse(stdout) as { clean: string; findings: unknown[] }
    expect(parsed.findings).toHaveLength(1)
  })

  it('on clean text reports no findings and returns 0', () => {
    const { stdout, status } = run(['scan', '-'], 'an ordinary product review')
    expect(stdout).toContain('no findings')
    expect(status).toBe(0)
  })

  it('returns 2 on an unknown command', () => {
    expect(run(['nonsense']).status).toBe(2)
  })

  it('refuses to scan several files instead of silently skipping', () => {
    // A check that looks wider than it is is more dangerous than a narrow
    // honest one: `scan a b` took the first argument and said nothing about
    // the rest, while the caller read "no findings" as a statement about all
    // the files at once.
    const dir = mkdtempSync(join(tmpdir(), 'cordon-'))
    const clean = join(dir, 'clean.md')
    const dirty = join(dir, 'dirty.md')
    writeFileSync(clean, 'ordinary text\n')
    writeFileSync(dirty, `text${ZWSP}with${ZWSP}a marker\n`)

    const { stdout, status } = run(['scan', clean, dirty])
    expect(status).toBe(2)
    expect(stdout).not.toContain('no findings')
  })
})

// The subcommand the harness calls. The run goes through a real process:
// testing runHook directly would fail to test exactly what breaks in real
// life — reading stdin, printing to stdout and the exit code.

describe('cordon hook', () => {
  function homeEnv(): Record<string, string> {
    return { CORDON_HOME: mkdtempSync(join(tmpdir(), 'cordon-hook-')) }
  }

  it('prints deny and exits zero on a call outside the default profile', () => {
    const event = JSON.stringify({
      session_id: 'cli', hook_event_name: 'PreToolUse',
      tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' },
    })
    const { stdout, status } = run(['hook'], event, homeEnv())
    expect(status).toBe(0)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('stays silent with an empty object on a read', () => {
    const event = JSON.stringify({
      session_id: 'cli', hook_event_name: 'PreToolUse',
      tool_name: 'Read', tool_input: { file_path: '/tmp/x' },
    })
    const { stdout, status } = run(['hook'], event, homeEnv())
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({})
  })

  it('prints deny on empty stdin instead of staying silent', () => {
    const { stdout, status } = run(['hook'], '', homeEnv())
    expect(status).toBe(0)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
