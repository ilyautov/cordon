import { describe, it, expect, beforeAll } from 'vitest'
import { ensureBuiltCli } from './support/built-cli.js'
import { PinStore } from '../src/session/pins.js'
import { ApprovalStore, approvalId } from '../src/session/approvals.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

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

  it('codex: a refusal exits 2, which Codex blocks on too', () => {
    const event = JSON.stringify({
      session_id: 'cli', cwd: '/tmp', hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: /tmp/x\n+y\n*** End Patch' },
    })
    const { stdout, status } = run(['hook', '--harness', 'codex'], event, homeEnv())
    expect(status).toBe(2)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('kimi: a refusal is printed as JSON, the form a live run confirmed', () => {
    const event = JSON.stringify({
      session_id: 'cli', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { path: '/tmp/x', content: 'y' },
    })
    const { stdout } = run(['hook', '--harness', 'kimi'], event, homeEnv())
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('deepseek: a refusal exits 2, which the bridge reads as a block', () => {
    const event = JSON.stringify({
      session_id: 'cli', hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { file_path: '/tmp/x', content: 'y' },
    })
    const { stdout, status } = run(['hook', '--harness', 'deepseek'], event, homeEnv())
    expect(status).toBe(2)
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny')
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

describe('cordon mcp approval wait flag', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  it('rejects a zero or malformed wait instead of silently starting the server', () => {
    for (const value of ['0', '-1', '1.5', 'wrong']) {
      const home = mkdtempSync(join(tmpdir(), 'cordon-mcp-cli-'))
      const result = run(['mcp', '--wait-for-approval-ms', value, '--', process.execPath, '-e', ''], '', { CORDON_HOME: home })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('wait-for-approval-ms')
    }
  })

  it('rejects unknown gateway flags', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-mcp-cli-'))
    const result = run(['mcp', '--unknown', '--', process.execPath, '-e', ''], '', { CORDON_HOME: home })
    expect(result.status).toBe(2)
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

  it('flushes a SARIF result larger than the pipe buffer before exiting', () => {
    const { root, home } = project()
    const mcpServers = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [
      `fs${index}`, { command: 'npx', args: ['server-fs'] },
    ]))
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers }))
    const { stdout, status } = run(['audit', root, '--sarif'], '', { HOME: home })
    expect(status).toBe(0)
    expect(stdout.length).toBeGreaterThan(64 * 1024)
    const sarif = JSON.parse(stdout)
    expect(sarif.version).toBe('2.1.0')
    expect(sarif.runs[0].results.length).toBeGreaterThan(100)
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

  it('names the rule of each event, and counts the classes by tier', () => {
    const exposed = JSON.stringify({ at: '2026-09-26T09:17:00.000Z', decision: 'deny', tool: 'send', reason: 'r', source: null, rule: 'exposure', class: 'unvouched-destination', tier: 'suspicion' })
    const key = JSON.stringify({ at: '2026-09-26T09:18:00.000Z', decision: 'ask', tool: 'post', reason: 'r', source: null, rule: 'credential', class: 'credential-egress', tier: 'precaution' })
    const { stdout } = run(['log'], '', { CORDON_HOME: journal([deny, exposed, key, exposed]) })
    expect(stdout).toContain('[exposure]')
    expect(stdout).toContain('suspicion: 2 unvouched-destination')
    expect(stdout).toContain('precaution: 1 credential-egress')
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
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'outside the certificate', args: { to: 'a@example.com' } })
    return { home, id }
  }

  it('lists what waits for the owner', () => {
    const { home, id } = waiting()
    const { stdout, status } = run(['approve'], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain(id)
    expect(stdout).toContain('send_email')
    expect(stdout).toContain('outside the certificate')
    expect(stdout).toContain('a@example.com')
  })

  it('makes invisible and direction-changing characters visible before owner approval', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approve-'))
    const args = {
      to: 'ops@example.com\u202Eattacker.example',
      body: 'review\u200Bme\u2066\uFE0F\u{E0100}',
    }
    const id = approvalId('s', { tool: 'send_email', args })
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'outside the certificate', args })

    const listed = run(['approve'], '', { CORDON_HOME: home })
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain('\\u202e')
    expect(listed.stdout).toContain('\\u200b')
    expect(listed.stdout).toContain('\\u2066')
    expect(listed.stdout).toContain('\\ufe0f')
    expect(listed.stdout).toContain('\\u{e0100}')
    expect(listed.stdout).not.toContain('\u202E')
    expect(listed.stdout).not.toContain('\u200B')
    expect(listed.stdout).not.toContain('\u2066')
    expect(listed.stdout).not.toContain('\uFE0F')
    expect(listed.stdout).not.toContain('\u{E0100}')

    const approved = run(['approve', id], '', { CORDON_HOME: home })
    expect(approved.status).toBe(0)
    expect(approved.stdout).toContain('\\u202e')
    expect(approved.stdout).not.toContain('\u202E')
    expect(new ApprovalStore(home).take(id, '').taken).toBe(true)
  })

  it('shows what the session had read when it asked', () => {
    // The owner approves a question, and what the agent had read is half of
    // it: the same call after a page is a different request (Kimi).
    const home = mkdtempSync(join(tmpdir(), 'cordon-approve-'))
    const id = 'ab'.repeat(8)
    new ApprovalStore(home).request(id, {
      tool: 'send_email', reason: 'r', args: { to: 'a@example.com' }, binding: 'ab'.repeat(32),
      context: { rule: 'exposure', exposure: 'https://evil.example/page', policy: 'p', turn: 2, reads: 1 },
    })
    expect(run(['approve'], '', { CORDON_HOME: home }).stdout).toContain('asked after reading https://evil.example/page')
    const { stdout } = run(['approve', id], '', { CORDON_HOME: home })
    expect(stdout).toContain('asked after reading https://evil.example/page')
    expect(stdout).toContain('[exposure]')
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
    expect(new ApprovalStore(home).take(id, '').taken).toBe(true)
  })

  it('an id nothing waits under is an error, not a silent success', () => {
    const { status, stderr } = run(['approve', '0123456789abcdef'], '', { CORDON_HOME: mkdtempSync(join(tmpdir(), 'cordon-approve-')) })
    expect(status).toBe(1)
    expect(stderr).toContain('nothing waits')
  })

  // Keys are sorted, so a long body puts the recipient after the cut: the owner
  // would approve an address they were never shown.
  function waitingLong() {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approve-'))
    const args = { body: 'x'.repeat(5000), to: 'attacker@evil.example' }
    const id = approvalId('s', { tool: 'send_email', args })
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'outside the certificate', args })
    return { home, id }
  }

  it('arguments longer than the screen are not approved unseen', () => {
    const { home, id } = waitingLong()
    const { stderr, status } = run(['approve', id], '', { CORDON_HOME: home })
    expect(status).toBe(1)
    expect(stderr).toContain(new ApprovalStore(home).pendingPath(id))
    expect(stderr).toContain('--read')
    expect(new ApprovalStore(home).take(id, '').taken).toBe(false)
  })

  it('the listing points to the whole request when it cuts the arguments', () => {
    const { home, id } = waitingLong()
    const { stdout } = run(['approve'], '', { CORDON_HOME: home })
    expect(stdout).toContain(new ApprovalStore(home).pendingPath(id))
  })

  it('the request file holds every argument, the recipient past the cut included', () => {
    const { home, id } = waitingLong()
    expect(readFileSync(new ApprovalStore(home).pendingPath(id), 'utf8')).toContain('attacker@evil.example')
  })

  it('with --read, a long request is approved and said back whole', () => {
    const { home, id } = waitingLong()
    const { stdout, status } = run(['approve', id, '--read'], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain('attacker@evil.example')
    expect(new ApprovalStore(home).take(id, '').taken).toBe(true)
  })

  it('a malformed id is a usage error', () => {
    expect(run(['approve', '../policy'], '', { CORDON_HOME: mkdtempSync(join(tmpdir(), 'cordon-approve-')) }).status).toBe(2)
  })
})

describe('cordon policy check and explain', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  function file(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cordon-policy-'))
    const path = join(dir, 'drafted.yaml')
    writeFileSync(path, body)
    return path
  }

  it('check passes a sound file and prints its notes', () => {
    const { stdout, status } = run(['policy', 'check', file('mode: interactive\nprofile:\n  effects: [read, financial]\n')], '', {})
    expect(status).toBe(0)
    expect(stdout).toContain('financial is granted')
  })

  it('distinguishes exec reach from a network-egress grant', () => {
    const { stdout, status } = run(['policy', 'check', file('mode: interactive\nprofile:\n  effects: [read, exec]\n')], '', {})
    expect(status).toBe(0)
    expect(stdout).toContain('cannot enforce path or host bounds or prevent network access by withholding network-egress')
    expect(stdout).not.toContain('the network is granted')
  })

  it('check fails a file the loader would refuse, with the loader\'s words', () => {
    const { stderr, status } = run(['policy', 'check', file('mode: sometimes\n')], '', {})
    expect(status).toBe(1)
    expect(stderr).toContain('mode must be interactive or autonomous')
  })

  it('check fails on a warning, so a drafted mandate that grants too much does not pass quietly', () => {
    const { stdout, status } = run(['policy', 'check', file('destinations: ["*@gmail.com"]\n')], '', {})
    expect(status).toBe(1)
    expect(stdout).toContain('public provider')
  })

  it('explain reads the policy back in words', () => {
    const { stdout, status } = run(['policy', 'explain', file('mode: autonomous\ndestinations: ["*@acme.example"]\n')], '', {})
    expect(status).toBe(0)
    expect(stdout).toContain('anything ending in @acme.example')
    expect(stdout).toContain('do not limit where the agent may send')
  })

  it('with no file, both read the policy in force', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    writeFileSync(join(home, 'policy.yaml'), 'mode: interactive\n')
    expect(run(['policy', 'explain'], '', { CORDON_HOME: home }).stdout).toContain('Mode: interactive')
  })
})

describe('records of who allowed what', () => {
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  function homeWithJournal(): { home: string; journal: string } {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const journal = join(home, 'events.jsonl')
    writeFileSync(join(home, 'policy.yaml'), `mode: interactive\nnotify:\n  file: ${journal}\n`)
    return { home, journal }
  }

  const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

  it('an approval is journaled with the OS user who gave it', () => {
    const { home, journal } = homeWithJournal()
    const id = 'cd'.repeat(8)
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'r', args: { to: 'a@example.com' }, binding: 'cd'.repeat(32) })
    expect(run(['approve', id], '', { CORDON_HOME: home }).status).toBe(0)
    const event = lines(journal).find((line) => line.decision === 'approval-given')
    expect(event?.approver).toBe(userInfo().username)
    expect(event?.id).toBe(id)
    expect(event?.binding).toBe('cd'.repeat(32))
    expect(event?.policy).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('an approval the journal cannot hold is not given', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const blocker = join(home, 'not-a-dir')
    writeFileSync(blocker, '')
    writeFileSync(join(home, 'policy.yaml'), `mode: interactive\nnotify:\n  file: ${join(blocker, 'events.jsonl')}\n`)
    const id = 'cf'.repeat(8)
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'r', args: {}, binding: 'cf'.repeat(32) })
    const { status, stderr } = run(['approve', id], '', { CORDON_HOME: home })
    expect(status).toBe(1)
    expect(stderr).toContain('not given')
    expect(new ApprovalStore(home).take(id, 'cf'.repeat(32)).taken).toBe(false)
  })

  it('an approval that cannot be written is recorded as lapsed', () => {
    // Codex, fourth review: the write threw and the journal kept only
    // approval-given.
    const { home, journal } = homeWithJournal()
    const id = 'c1'.repeat(8)
    const store = new ApprovalStore(home)
    store.request(id, { tool: 'send_email', reason: 'r', args: {}, binding: 'c1'.repeat(32) })
    const dir = dirname(store.pendingPath(id))
    chmodSync(dir, 0o500)
    try {
      const { status } = run(['approve', id], '', { CORDON_HOME: home })
      expect(status).toBe(1)
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(lines(journal).map((line) => line.decision)).toEqual(expect.arrayContaining(['approval-given', 'approval-lapsed']))
  })

  it('--as is recorded as declared, apart from the OS user', () => {
    // Anyone at the shell types any name (Kimi): it is labelled as a claim.
    const { home, journal } = homeWithJournal()
    const id = 'ce'.repeat(8)
    new ApprovalStore(home).request(id, { tool: 'send_email', reason: 'r', args: {}, binding: 'ce'.repeat(32) })
    run(['approve', id, '--as', 'Ilya'], '', { CORDON_HOME: home })
    const event = lines(journal).find((line) => line.decision === 'approval-given')
    expect(event?.declared).toBe('Ilya')
    expect(event?.approver).toBe(userInfo().username)
  })

  it('policy apply installs a checked file and journals its hash and who applied it', () => {
    const { home, journal } = homeWithJournal()
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    const body = `mode: interactive\nprofile:\n  effects: [read, create]\nnotify:\n  file: ${journal}\n`
    writeFileSync(drafted, body)
    const { status, stdout } = run(['policy', 'apply', drafted], '', { CORDON_HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain('The agent may: read, create')
    expect(readFileSync(join(home, 'policy.yaml'), 'utf8')).toBe(body)
    const event = lines(journal).find((line) => line.decision === 'policy-applied')
    expect(event?.approver).toBe(userInfo().username)
    expect(event?.policy).toMatch(/^[0-9a-f]{64}$/u)
    expect(event?.previous).toMatch(/^[0-9a-f]{64}$/u)
    expect(event?.policy).not.toBe(event?.previous)
  })

  it('policy apply records the change in the old journal too, so a draft cannot move the record away', () => {
    // A drafted policy can point notify.file anywhere; the SIEM tails the old
    // file, and that is where the change must show.
    const { home, journal } = homeWithJournal()
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'cordon-elsewhere-')), 'quiet.jsonl')
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    writeFileSync(drafted, `mode: interactive\nnotify:\n  file: ${elsewhere}\n`)
    expect(run(['policy', 'apply', drafted], '', { CORDON_HOME: home }).status).toBe(0)
    expect(lines(journal).some((line) => line.decision === 'policy-applied')).toBe(true)
    expect(lines(elsewhere).some((line) => line.decision === 'policy-applied')).toBe(true)
  })

  it('policy apply with a new journal nobody can write is not applied, and the old journal says so', () => {
    // Codex, third review: the new journal was written first, its failure
    // stopped the loop, and the SIEM on the old one never saw the change —
    // with the new policy in force and every later event dropped. Kimi: a
    // policy whose journal cannot be written is not left in force.
    const { home, journal } = homeWithJournal()
    const before = readFileSync(join(home, 'policy.yaml'), 'utf8')
    const blocker = join(home, 'not-a-dir')
    writeFileSync(blocker, '')
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    writeFileSync(drafted, `mode: interactive\nnotify:\n  file: ${join(blocker, 'events.jsonl')}\n`)
    const { status, stderr } = run(['policy', 'apply', drafted], '', { CORDON_HOME: home })
    expect(status).toBe(1)
    expect(stderr).toContain('nothing was applied')
    expect(readFileSync(join(home, 'policy.yaml'), 'utf8')).toBe(before)
    const decisions = lines(journal).map((line) => line.decision)
    expect(decisions).toContain('policy-apply-failed')
  })

  it('policy apply that cannot make its home says so in the journal it wrote to', () => {
    // Codex, fourth review: the home was made outside the compensated path.
    const locked = mkdtempSync(join(tmpdir(), 'cordon-locked-'))
    const home = join(locked, 'home')
    const journal = join(mkdtempSync(join(tmpdir(), 'cordon-journal-')), 'events.jsonl')
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    writeFileSync(drafted, `mode: interactive\nnotify:\n  file: ${journal}\n`)
    chmodSync(locked, 0o500)
    try {
      expect(run(['policy', 'apply', drafted], '', { CORDON_HOME: home }).status).toBe(1)
    } finally {
      chmodSync(locked, 0o700)
    }
    expect(lines(journal).map((line) => line.decision)).toEqual(['policy-applied', 'policy-apply-failed'])
  })

  it('policy apply names where the journal goes next', () => {
    // Kimi, third review: a SIEM tailing the old file otherwise sees the
    // change and then silence.
    const { home, journal } = homeWithJournal()
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'cordon-elsewhere-')), 'next.jsonl')
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    writeFileSync(drafted, `mode: interactive\nnotify:\n  file: ${elsewhere}\n`)
    expect(run(['policy', 'apply', drafted], '', { CORDON_HOME: home }).status).toBe(0)
    const event = lines(journal).find((line) => line.decision === 'policy-applied')
    expect(event?.reason).toContain(elsewhere)
  })

  it('policy apply refuses a file with warnings unless they are accepted by name', () => {
    const { home } = homeWithJournal()
    const before = readFileSync(join(home, 'policy.yaml'), 'utf8')
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    writeFileSync(drafted, 'destinations: ["*@gmail.com"]\n')
    expect(run(['policy', 'apply', drafted], '', { CORDON_HOME: home }).status).toBe(1)
    expect(readFileSync(join(home, 'policy.yaml'), 'utf8')).toBe(before)
    expect(run(['policy', 'apply', drafted, '--accept-warnings'], '', { CORDON_HOME: home }).status).toBe(0)
  })

  it('policy apply refuses a file the loader refuses, and leaves the policy alone', () => {
    const { home } = homeWithJournal()
    const before = readFileSync(join(home, 'policy.yaml'), 'utf8')
    const drafted = join(mkdtempSync(join(tmpdir(), 'cordon-draft-')), 'p.yaml')
    writeFileSync(drafted, 'mode: sometimes\n')
    expect(run(['policy', 'apply', drafted], '', { CORDON_HOME: home }).status).toBe(1)
    expect(readFileSync(join(home, 'policy.yaml'), 'utf8')).toBe(before)
  })
})
