import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type Policy } from '../../src/policy/defaults.js'
import { explain, lint } from '../../src/policy/explain.js'

/**
 * The owner approves a policy by reading it back in plain words, not by
 * reading YAML: a mandate drafted by a model outside Cordon is checked here,
 * deterministically, before anyone relies on it. The words must say what
 * the code does, including what a field does NOT do: `destinations` exempts
 * and does not confine, `tools` classifies and does not allow, and an empty
 * list of paths bounds nothing (Codex).
 */

function policy(overrides: Partial<Policy> = {}): Policy {
  return { ...structuredClone(DEFAULT_POLICY), ...overrides }
}

const text = (p: Policy) => explain(p).join('\n')
const found = (p: Policy) => lint(p).map((finding) => `${finding.level}: ${finding.text}`).join('\n')

describe('explain', () => {
  it('says who decides in doubt', () => {
    expect(text(policy({ mode: 'interactive' }))).toMatch(/asks you/)
    expect(text(policy({ mode: 'autonomous' }))).toMatch(/refuses/)
  })

  it('lists what the agent may and may not do', () => {
    const out = text(policy({ profile: { effects: ['read', 'network-egress'], resources: { paths: [], hosts: [] } } }))
    expect(out).toMatch(/may: read, network-egress/)
    expect(out).toMatch(/may not: .*financial/)
  })

  it('says that empty resource lists bound nothing', () => {
    expect(text(policy())).toMatch(/files: anywhere/i)
    expect(text(policy({ profile: { effects: ['read'], resources: { paths: ['/srv/app/'], hosts: ['api.example.com'] } } })))
      .toMatch(/only under \/srv\/app\/[\s\S]*only api\.example\.com/)
  })

  it('says destinations exempt after a read and do not confine', () => {
    const out = text(policy({ destinations: ['*@acme.example', 'ops@partner.example'] }))
    expect(out).toMatch(/anything ending in @acme\.example/)
    expect(out).toMatch(/ops@partner\.example/)
    expect(out).toMatch(/do not limit where the agent may send/)
  })

  it('says tools classify and do not allow', () => {
    const out = text(policy({ tools: { pay: ['financial'] } }))
    expect(out).toMatch(/pay counts as financial/)
    expect(out).toMatch(/classif/)
  })

  it('names a controlled field and what it demands', () => {
    const out = text(policy({ arguments: { pay: { amount: 'controlled' } } }))
    expect(out).toMatch(/pay\.amount/)
    expect(out).toMatch(/you assigned in your message/)
  })

  it('states each budget as a cap across sessions', () => {
    const out = text(policy({ budgets: [{ effect: 'network-egress', limit: 20, per: 'hour' }] }))
    expect(out).toMatch(/at most 20 network-egress calls per hour/)
    expect(out).toMatch(/every session/)
  })

  it('says bounds do not reach inside a shell command', () => {
    // Codex, third review: "Hosts: only X" next to a granted shell is false;
    // bounds read recognized path and URL fields, never a command's text.
    const out = text(policy({ profile: { effects: ['read', 'exec'], resources: { paths: ['/safe/'], hosts: ['safe.example'] } } }))
    expect(out).toMatch(/shell command/)
    expect(out).toMatch(/not bounded/)
  })

  it('names what tools return and whether the footer is shown', () => {
    // Kimi, third review: two fields the read-back never mentioned.
    const out = text(policy({ toolsReturn: { Read: 'rendered' }, output: { footer: false } }))
    expect(out).toMatch(/Read returns rendered/)
    expect(out).toMatch(/footer.*off/i)
  })

  it('says a read of something you never named is gated too, after an untrusted read', () => {
    // Kimi, third review: the paragraph said only calls beyond reading were.
    expect(text(policy())).toMatch(/a read of a resource you never named/)
  })

  it('says the exposure rule is off, when it is', () => {
    expect(text(policy({ exposure: false }))).toMatch(/exposure rule is OFF/)
  })
})

describe('lint', () => {
  it('a clean default says nothing alarming', () => {
    expect(lint(policy()).filter((finding) => finding.level === 'warning')).toEqual([])
  })

  it('warns on the exposure rule switched off', () => {
    expect(found(policy({ exposure: false }))).toMatch(/warning: .*exposure/)
  })

  it('warns on a destination that matches a whole domain zone or a public mailbox provider', () => {
    expect(found(policy({ destinations: ['*.com'] }))).toMatch(/warning: .*\*\.com/)
    expect(found(policy({ destinations: ['*@gmail.com'] }))).toMatch(/warning: .*\*@gmail\.com/)
    expect(found(policy({ destinations: ['*@acme.example'] }))).not.toMatch(/warning/)
  })

  it('warns on a public provider however the pattern is spelled', () => {
    // Codex, third review: the gate normalizes a pattern before matching, so
    // the warning has to read the same normalized pattern.
    expect(found(policy({ destinations: [' *@GMAIL.com '] }))).toMatch(/warning: .*public provider/)
    expect(found(policy({ destinations: ['*gmail.com'] }))).toMatch(/warning: .*public provider/)
    expect(found(policy({ destinations: ['*@mail.gmail.com'] }))).toMatch(/warning: .*public provider/)
  })

  it('warns on a declaration that takes effects away from a built-in tool', () => {
    // Codex, third review: `Bash: [read]` makes every shell command a read,
    // and the default read-only profile then lets `rm -rf` through.
    expect(found(policy({ tools: { Bash: ['read'] } }))).toMatch(/warning: .*Bash.*exec/)
    expect(found(policy({ tools: { Write: ['create', 'update'] } }))).not.toMatch(/warning/)
    // Gemini's shell too (Codex, fourth review).
    expect(found(policy({ tools: { run_shell_command: ['read'] } }))).toMatch(/warning: .*run_shell_command.*exec/)
    expect(found(policy({ tools: { WebFetch: ['read', 'network-egress', 'export'] } }))).not.toMatch(/warning/)
  })

  it('says that a blocked tool cannot be approved', () => {
    expect(text(policy({ blockedTools: ['Bash'] }))).toMatch(/Blocked tools: Bash.*no approval lifts/u)
  })

  it('does not claim every shell command is refused after a read', () => {
    const out = found(policy({ mode: 'autonomous', profile: { effects: ['read', 'exec'], resources: { paths: [], hosts: [] } } }))
    expect(out).toMatch(/warning: .*exec/)
    expect(out).not.toMatch(/every one is refused/)
  })

  it('warns on a file tool declared as returning a rendered view', () => {
    // The file then comes back rendered, and a write-back destroys it.
    expect(found(policy({ toolsReturn: { Read: 'rendered' } }))).toMatch(/warning: .*Read/)
  })

  it('notes a shell granted in interactive mode, and writes with no path bound', () => {
    // Kimi, third review.
    const out = found(policy({ mode: 'interactive', profile: { effects: ['read', 'update', 'exec'], resources: { paths: [], hosts: ['api.example.com'] } } }))
    expect(out).toMatch(/note: .*exec/)
    expect(out).toMatch(/note: .*no paths/)
  })

  it('warns on an autonomous policy with no journal', () => {
    expect(found(policy({ mode: 'autonomous', notify: { file: null }, profile: { effects: ['read', 'create'], resources: { paths: [], hosts: [] } } }))).toMatch(/warning: .*journal/)
  })

  it('warns on trusted sources and on unpinned MCP tools', () => {
    expect(found(policy({ trustedSources: ['https://wiki.example'] }))).toMatch(/warning: .*wiki\.example/)
    expect(found(policy({ mcp: { pin: false } }))).toMatch(/warning: .*pin/)
  })

  it('notes every irreversible effect granted, and the shell in autonomous mode', () => {
    const out = found(policy({ mode: 'autonomous', profile: { effects: ['read', 'financial', 'exec'], resources: { paths: [], hosts: [] } } }))
    expect(out).toMatch(/note: .*financial/)
    expect(out).toMatch(/warning: .*exec/)
  })

  it('notes an unattended agent that acts outward with no budget', () => {
    expect(found(policy({ mode: 'autonomous', profile: { effects: ['read', 'network-egress'], resources: { paths: [], hosts: [] } } })))
      .toMatch(/note: .*no budget/)
    expect(found(policy({
      mode: 'autonomous',
      profile: { effects: ['read', 'network-egress'], resources: { paths: [], hosts: [] } },
      budgets: [{ effect: 'network-egress', limit: 5, per: 'hour' }],
    }))).not.toMatch(/no budget/)
  })

  it('notes a network grant with no hosts named', () => {
    expect(found(policy({ profile: { effects: ['read', 'network-egress'], resources: { paths: [], hosts: [] } } }))).toMatch(/note: .*any host/)
  })
})
