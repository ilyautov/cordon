import { describe, it, expect, beforeAll } from 'vitest'
import { ensureBuiltCli } from './support/built-cli.js'
import { PinStore } from '../src/session/pins.js'
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
    ensureBuiltCli()
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

  it('prints deny and exits 2 on a call outside the default profile', () => {
    // Exit 2 is the one code Claude Code blocks on whatever stdout holds: a
    // JSON the harness stops accepting would otherwise read as a non-blocking
    // error, and the call would go through. With valid JSON the harness
    // decides by the JSON alone, so the code changes nothing there.
    const event = JSON.stringify({
      session_id: 'cli', hook_event_name: 'PreToolUse',
      tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' },
    })
    const { stdout, status } = run(['hook'], event, homeEnv())
    expect(status).toBe(2)
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
    expect(status).toBe(2)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('cordon mcp approve', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  it('forgets the pins of the named server', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approve-'))
    new PinStore(home).save(['npx', 'server-x'], { a: 'h' })

    const { stdout, status } = run(['mcp', 'approve', '--', 'npx', 'server-x'], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain('npx server-x')
    expect(new PinStore(home).load(['npx', 'server-x'])).toBeNull()
  })

  it('says so when the server had no pins', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approve-'))
    const { stdout, status } = run(['mcp', 'approve', '--', 'npx', 'nothing'], '', { CORDON_HOME: home })
    expect(status).toBe(1)
    expect(stdout).toContain('no pins')
  })
})

describe('cordon audit', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  function project(): { root: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), 'cordon-audit-cli-'))
    const home = mkdtempSync(join(tmpdir(), 'cordon-audit-home-'))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['server-fs'] } } }))
    return { root, home }
  }

  it('prints the findings with their codes and exits 0 by default', () => {
    const { root, home } = project()
    const { stdout, status } = run(['audit', root], '', { HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain('CA201')
    expect(stdout).toContain('CA202')
  })

  it('--fail-on fails the run at or above the named severity', () => {
    const { root, home } = project()
    expect(run(['audit', root, '--fail-on', 'medium'], '', { HOME: home }).status).toBe(1)
    expect(run(['audit', root, '--fail-on', 'high'], '', { HOME: home }).status).toBe(0)
  })

  it('--json prints the findings as JSON', () => {
    const { root, home } = project()
    const parsed = JSON.parse(run(['audit', root, '--json'], '', { HOME: home }).stdout) as Array<{ code: string }>
    expect(parsed.map((finding) => finding.code)).toContain('CA201')
  })

  it('--sarif prints SARIF 2.1.0 for code scanning', () => {
    const { root, home } = project()
    const sarif = JSON.parse(run(['audit', root, '--sarif'], '', { HOME: home }).stdout)
    expect(sarif.version).toBe('2.1.0')
    expect(sarif.runs[0].tool.driver.name).toBe('cordon')
    expect(sarif.runs[0].results.map((result: { ruleId: string }) => result.ruleId)).toContain('CA201')
  })

  it('an unknown severity is a usage error', () => {
    const { root, home } = project()
    expect(run(['audit', root, '--fail-on', 'critical'], '', { HOME: home }).status).toBe(2)
  })
})
