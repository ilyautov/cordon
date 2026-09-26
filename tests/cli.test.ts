import { describe, it, expect, beforeAll } from 'vitest'
import { ensureBuiltCli } from './support/built-cli.js'
import { PinStore } from '../src/session/pins.js'
import { ApprovalStore, approvalId } from '../src/session/approvals.js'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'cli.js')

/** A zero-width marker. Escape only: a literal is invisible during review. */
const ZWSP = '\u200B'

function run(
  args: string[],
  input?: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI, ...args], {
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 }
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

describe('cordon hook: a home the project itself supplies', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  // Project settings can set `env`, and Claude Code hands it to hook
  // processes — verified live. A cloned repository could point CORDON_HOME at
  // a directory of its own holding a permissive policy, and the defence would
  // switch itself off with every check still reporting green.
  const event = JSON.stringify({ session_id: 'h1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } })

  it('refuses when CORDON_HOME lies inside the project directory', () => {
    const project = mkdtempSync(join(tmpdir(), 'cordon-project-'))
    const home = join(project, '.cordon-here')
    const { stdout, status } = run(['hook'], event, { CORDON_HOME: home, CLAUDE_PROJECT_DIR: project })
    expect(status).toBe(2)
    expect(stdout).toContain('inside the project')
  })

  it('works when CORDON_HOME lies outside the project directory', () => {
    const project = mkdtempSync(join(tmpdir(), 'cordon-project-'))
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const { status } = run(['hook'], event, { CORDON_HOME: home, CLAUDE_PROJECT_DIR: project })
    expect(status).toBe(0)
  })

  it('a session started in the home directory itself is not a project', () => {
    // Claude Code started in ~ has ~ as its project directory, and every
    // home Cordon could use lies inside it.
    const user = mkdtempSync(join(tmpdir(), 'cordon-user-'))
    const { status } = run(['hook'], event, { HOME: user, CORDON_HOME: join(user, '.cordon'), CLAUDE_PROJECT_DIR: user })
    expect(status).toBe(0)
  })
})

describe('CORDON_HOME with a leading tilde', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  it('is expanded against the user home, so managed settings can pin it for every user', () => {
    const user = mkdtempSync(join(tmpdir(), 'cordon-tilde-'))
    const { stdout } = run(['doctor'], '', { HOME: user, CORDON_HOME: '~/.cordon-pinned' })
    expect(stdout).toContain(join(user, '.cordon-pinned'))
  })
})

describe('cordon init', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  it('writes the named profile into the home and prints where', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-init-'))
    const { stdout, status } = run(['init', '--profile', 'coding'], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain(join(home, 'policy.yaml'))
    expect(readFileSync(join(home, 'policy.yaml'), 'utf8')).toContain('exec')
  })

  it('never overwrites a policy without --force', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-init-'))
    writeFileSync(join(home, 'policy.yaml'), 'mode: interactive\n')
    expect(run(['init', '--profile', 'coding'], '', { CORDON_HOME: home }).status).toBe(1)
    expect(readFileSync(join(home, 'policy.yaml'), 'utf8')).toBe('mode: interactive\n')
    expect(run(['init', '--profile', 'coding', '--force'], '', { CORDON_HOME: home }).status).toBe(0)
  })

  it('an unknown profile is a usage error', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-init-'))
    expect(run(['init', '--profile', 'everything'], '', { CORDON_HOME: home }).status).toBe(2)
  })
})

describe('cordon log', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  function journal(lines: string[]): string {
    const home = mkdtempSync(join(tmpdir(), 'cordon-log-'))
    const file = join(home, 'events.jsonl')
    writeFileSync(join(home, 'policy.yaml'), `notify:\n  file: ${file}\n`)
    writeFileSync(file, lines.join('\n') + '\n')
    return home
  }

  const deny = JSON.stringify({ at: '2026-09-26T09:14:02.118Z', decision: 'deny', tool: 'WebFetch', reason: 'the link came from the page', source: 'https://a.example/x' })
  const rewrite = JSON.stringify({ at: '2026-09-26T09:15:00.000Z', decision: 'rewrite', tool: 'Write', reason: 'an untrusted fragment was cut out', source: null })
  const drift = JSON.stringify({ at: '2026-09-26T09:16:00.000Z', decision: 'mcp-drift', tool: 'mystery_box', reason: 'changed', source: 'fake-server' })

  it('prints each event and a count by decision', () => {
    const { stdout, status } = run(['log'], '', { CORDON_HOME: journal([deny, rewrite, drift]) })
    expect(status).toBe(0)
    expect(stdout).toContain('WebFetch')
    expect(stdout).toContain('the link came from the page')
    expect(stdout).toContain('https://a.example/x')
    expect(stdout).toContain('3 events: 1 deny, 1 rewrite, 1 mcp-drift')
  })

  it('--last keeps only the newest events', () => {
    const { stdout } = run(['log', '--last', '1'], '', { CORDON_HOME: journal([deny, rewrite, drift]) })
    expect(stdout).toContain('mystery_box')
    expect(stdout).not.toContain('WebFetch')
  })

  it('--json prints the events as an array', () => {
    const { stdout, status } = run(['log', '--json'], '', { CORDON_HOME: journal([deny, drift]) })
    expect(status).toBe(0)
    const events = JSON.parse(stdout) as Array<{ tool: string }>
    expect(events.map((event) => event.tool)).toEqual(['WebFetch', 'mystery_box'])
  })

  it('names a line it could not read instead of skipping it quietly', () => {
    const { stdout, status } = run(['log'], '', { CORDON_HOME: journal([deny, '{"at":', drift]) })
    expect(status).toBe(0)
    expect(stdout).toContain('1 line could not be read')
  })

  it('a control sequence from a page never reaches the terminal', () => {
    const planted = JSON.stringify({ at: '2026-09-26T09:14:02.118Z', decision: 'deny', tool: 'WebFetch', reason: 'x', source: 'https://a.example/\u001b[2J\u001b]0;owned\u0007' })
    const { stdout } = run(['log'], '', { CORDON_HOME: journal([planted]) })
    expect(stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u)
    expect(stdout).toContain('\\u001b[2J')
  })

  it('without a journal in the policy it says so and fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-log-'))
    const { stderr, status } = run(['log'], '', { CORDON_HOME: home })
    expect(status).toBe(1)
    expect(stderr).toContain('notify.file')
  })

  it('a configured journal that is not written yet is no events, not an error', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-log-'))
    writeFileSync(join(home, 'policy.yaml'), `notify:\n  file: ${join(home, 'events.jsonl')}\n`)
    const { stdout, status } = run(['log'], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain('no events')
  })

  it('a broken policy fails loudly', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-log-'))
    writeFileSync(join(home, 'policy.yaml'), 'mode: sometimes\n')
    expect(run(['log'], '', { CORDON_HOME: home }).status).toBe(1)
  })
})

describe('cordon approve', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  function waiting() {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approve-'))
    const id = approvalId('s', { tool: 'send_email', args: { to: 'a@example.com' } })
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'outside the certificate' })
    return { home, id }
  }

  it('lists what waits for the owner', () => {
    const { home, id } = waiting()
    const { stdout, status } = run(['approve'], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain(id)
    expect(stdout).toContain('send_email')
    expect(stdout).toContain('outside the certificate')
  })

  it('says so when nothing waits', () => {
    const { stdout, status } = run(['approve'], '', { CORDON_HOME: mkdtempSync(join(tmpdir(), 'cordon-approve-')) })
    expect(status).toBe(0)
    expect(stdout).toContain('nothing waits')
  })

  it('approves one call and says back what was approved', () => {
    const { home, id } = waiting()
    const { stdout, status } = run(['approve', id], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain('send_email')
    expect(new ApprovalStore(home).consume(id)).toBe(true)
  })

  it('an id nothing waits under is an error, not a silent success', () => {
    const { status, stderr } = run(['approve', '0123456789abcdef'], '', { CORDON_HOME: mkdtempSync(join(tmpdir(), 'cordon-approve-')) })
    expect(status).toBe(1)
    expect(stderr).toContain('nothing waits')
  })

  it('a malformed id is a usage error', () => {
    expect(run(['approve', '../policy'], '', { CORDON_HOME: mkdtempSync(join(tmpdir(), 'cordon-approve-')) }).status).toBe(2)
  })
})
