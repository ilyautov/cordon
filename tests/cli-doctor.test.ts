import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ensureBuiltCli } from './support/built-cli.js'
import { doctor } from '../src/cli.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-doctor-'))
}

/** Directories stripped of write permission: it must be given back. */
const locked: string[] = []

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o700)
})

describe('cordon doctor', () => {
  it('reports the default policy', () => {
    const report = doctor(home())
    expect(report.policySource).toBe('default')
    expect(report.mode).toBe('autonomous')
    expect(report.effects).toEqual(['read', 'summarize'])
  })

  it("sees the user's policy", () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'mode: interactive\n')
    expect(doctor(dir).policySource).toContain('policy.yaml')
    expect(doctor(dir).mode).toBe('interactive')
  })

  it('warns about autonomous mode without notification', () => {
    const report = doctor(home())
    expect(report.warnings.some((w) => w.includes('notification'))).toBe(true)
  })

  it('runs the self-check on an attack sample', () => {
    const report = doctor(home())
    expect(report.selfCheck).toBe('ok')
  })
})

describe('cordon doctor: warnings', () => {
  it('warns about exec in the profile', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'profile:\n  effects: [read, exec]\n')
    expect(doctor(dir).warnings.some((w) => w.includes('exec'))).toBe(true)
  })

  it('warns about trusted sources with no declared tools', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'trustedSources:\n  - /Users/name/project\n')
    expect(doctor(dir).warnings.some((w) => w.includes('trustedSources'))).toBe(true)
  })

  it('file notification removes the autonomous-mode warning', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), `notify:\n  file: ${join(dir, 'events.jsonl')}\n`)
    expect(doctor(dir).warnings.some((w) => w.includes('notification'))).toBe(false)
  })

  it('a webhook does not pass for a notification channel', () => {
    // It used to. The field was accepted, counted as a channel, and nothing
    // was ever delivered to it, so the warning about autonomous mode without
    // notification disappeared while the notification did too.
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'notify:\n  webhook: https://example.test/hook\n')
    const report = doctor(dir)
    expect(report.warnings.some((w) => w.includes('webhook'))).toBe(true)
    expect(report.selfCheck).toBe('broken')
  })

  it('does not warn about notification in interactive mode', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'mode: interactive\n')
    expect(doctor(dir).warnings.some((w) => w.includes('notification'))).toBe(false)
  })

  it('says what quarantine in autonomous mode rests on, and where it was measured', () => {
    // Claude Code 2.1.236 was measured to apply updatedInput without a
    // permissionDecision, so the old wording — that nobody knows — is no
    // longer true. Dropping the warning outright would be the other error:
    // Cordon ships a second adapter where this has not been measured at all,
    // and a reader of doctor's output has no way to tell which harness the
    // silence covers.
    const warning = doctor(home()).warnings.find((w) => w.includes('updatedInput'))
    expect(warning).toBeDefined()
    expect(warning).toContain('Claude Code')
    expect(warning).toContain('Gemini CLI')
  })
})

describe('cordon doctor: a broken installation', () => {
  it('an unreadable policy is a breakage report, not an exception', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'mode: [not a string\n')
    const report = doctor(dir)
    expect(report.selfCheck).toBe('broken')
    expect(report.warnings.join(' ')).toContain('policy.yaml')
  })

  it('a policy with an unknown effect class is a breakage, not silence', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'profile:\n  effects: [read, money]\n')
    const report = doctor(dir)
    expect(report.selfCheck).toBe('broken')
  })

  it('a home directory without write permission is a breakage', () => {
    // Session state lives on disk. Unable to write it, Cordon refuses on
    // every call: fail-closed did fire, but work has stopped, and the user
    // must learn the reason from doctor rather than from the agent.
    const dir = home()
    chmodSync(dir, 0o500)
    locked.push(dir)
    const report = doctor(dir)
    expect(report.warnings.some((w) => w.includes('write permission'))).toBe(true)
  })

  it("the self-check leaves no traces in the user's home directory", () => {
    // The self-check drives real events through the real path. Doing that in
    // live session state is not allowed: doctor must answer a question about
    // the state of the installation rather than change it.
    const dir = home()
    doctor(dir)
    expect(existsSync(join(dir, 'sessions'))).toBe(false)
  })
})

describe('cordon doctor: printing for the human', () => {
  // The printed output comes from dist/cli.js started as a separate process,
  // and on a fresh clone that file has not been built yet.
  beforeAll(() => {
    ensureBuiltCli()
  }, 60_000)

  it('says out loud that it does not check the wiring', () => {
    // "self-check: ok" without that caveat reads as "the defence is in
    // place". A hook the harness never calls looks from the outside like a
    // hook that had no reason to fire.
    const dir = home()
    const out = execFileSync('node', [join(process.cwd(), 'plugin', 'dist', 'cli.js'), 'doctor'], {
      input: '',
      env: { ...process.env, CORDON_HOME: dir },
      encoding: 'utf8',
    })
    expect(out).toContain('self-check: ok')
    expect(out).toContain('/hooks')
  })

  it('non-zero exit code only on a breakage', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'mode: [not a string\n')
    let code = 0
    try {
      execFileSync('node', [join(process.cwd(), 'plugin', 'dist', 'cli.js'), 'doctor'], {
        input: '',
        env: { ...process.env, CORDON_HOME: dir },
        encoding: 'utf8',
      })
    } catch (error) {
      code = (error as { status: number }).status
    }
    expect(code).toBe(1)
  })
})

describe('doctor: the exposure valve', () => {
  it('names the exposure state instead of staying silent about it', () => {
    // A switched-off exposure rule is indistinguishable from the outside from
    // a session that simply read nothing untrusted: either way nothing
    // escalates. That is exactly the ambiguity doctor removes.
    const dir = mkdtempSync(join(tmpdir(), 'cordon-doctor-'))
    expect(doctor(dir).exposure).toBe(true)

    writeFileSync(join(dir, 'policy.yaml'), 'exposure: false\n')
    expect(doctor(dir).exposure).toBe(false)
  })

  it('warns when exposure is switched off, with the price named', () => {
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'exposure: false\n')
    expect(doctor(dir).warnings.some((w) => w.includes('exposure'))).toBe(true)
  })
})

describe('doctor: the third axis', () => {  it('names the footer state instead of staying silent about it', () => {
    // A switched-off footer is indistinguishable from the outside from a
    // footer that has nothing to say. That is exactly the ambiguity doctor
    // removes.
    const dir = mkdtempSync(join(tmpdir(), 'cordon-doctor-'))
    expect(doctor(dir).footer).toBe(true)

    writeFileSync(join(dir, 'policy.yaml'), 'output:\n  footer: false\n')
    expect(doctor(dir).footer).toBe(false)
  })
})

describe('doctor: the default source view', () => {
  it('names the effective MCP default as a field of the report', () => {
    // The human should not have to learn the default from the source:
    // whether the hidden layer is stripped from an MCP server's result
    // depends on it.
    expect(doctor(home()).mcpView).toBe('source')
  })

  it('prints the default out loud', () => {
    const dir = home()
    const out = execFileSync('node', [join(process.cwd(), 'plugin', 'dist', 'cli.js'), 'doctor'], {
      input: '',
      env: { ...process.env, CORDON_HOME: dir },
      encoding: 'utf8',
    })
    expect(out).toContain('source, hidden layer is not stripped')
    expect(out).toContain('toolsReturn')
  })

  it("lists the user's declarations", () => {
    const dir = home()
    writeFileSync(
      join(dir, 'policy.yaml'),
      'toolsReturn:\n  mcp__wb__reviews: rendered\n  mcp__filesystem__read_file: source\n',
    )
    const report = doctor(dir)
    expect(report.declaredViews).toEqual([
      'mcp__filesystem__read_file: source',
      'mcp__wb__reviews: rendered',
    ])
  })

  it('warns when file reading is declared as rendered', () => {
    // Exactly the bug closed earlier: substituting a read result destroys the
    // file's markup when it is written back. The declaration cannot be
    // forbidden, it is deliberate, but staying silent about it is worse.
    const dir = home()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn:\n  Read: rendered\n')
    expect(doctor(dir).warnings.some((w) => w.includes('Read'))).toBe(true)
  })

  it('names both harnesses and how the second is worse than the first', () => {
    // The user picks a harness before installing and learns the difference
    // afterwards. Silence here means promising identical behaviour, which
    // Cordon does not give.
    const report = doctor(home())

    expect(report.harnesses.map((h) => h.name).sort()).toEqual(['claude-code', 'gemini-cli'])

    const gemini = report.harnesses.find((h) => h.name === 'gemini-cli')
    expect(gemini?.limits.join(' ')).toContain('tool result')
    expect(gemini?.limits.length).toBeGreaterThanOrEqual(3)
  })

  it("doctor's output states the second harness's limits in words", () => {
    // A field in a structure that is never printed does not help the reader.
    const dir = home()
    const out = execFileSync('node', [join(process.cwd(), 'dist', 'cli.js'), 'doctor'], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, CORDON_HOME: dir },
    })

    expect(out).toContain('gemini-cli')
    expect(out).toMatch(/tool result/u)
  })
})
