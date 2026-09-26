import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../../src/policy/load.js'
import { DEFAULT_POLICY } from '../../src/policy/defaults.js'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-policy-'))
}

describe('loadPolicy', () => {
  it('returns a working default when there is no file', () => {
    expect(loadPolicy(scratch())).toEqual(DEFAULT_POLICY)
  })

  it('the default is autonomous and fail-closed', () => {
    expect(DEFAULT_POLICY.mode).toBe('autonomous')
    expect(DEFAULT_POLICY.profile.effects).toEqual(['read', 'summarize'])
  })

  it('reads the policy from the home directory', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'mode: interactive\n')
    expect(loadPolicy(home).mode).toBe('interactive')
  })

  it('ignores a cordon.yaml in the working directory', () => {
    const home = scratch()
    const cwd = scratch()
    writeFileSync(join(cwd, 'cordon.yaml'), 'mode: interactive\n')
    const before = process.cwd()
    try {
      process.chdir(cwd)
      expect(loadPolicy(home).mode).toBe('autonomous')
    } finally {
      process.chdir(before)
    }
  })

  it('broken YAML is a refusal, not a silent default', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'mode: [unclosed\n')
    expect(() => loadPolicy(home)).toThrow(/policy\.yaml/)
  })

  it('an unknown mode is a refusal', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'mode: off\n')
    expect(() => loadPolicy(home)).toThrow(/mode/)
  })

  it('an unknown effect class in the profile is a refusal', () => {
    const home = scratch()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'policy.yaml'), 'profile:\n  effects: [read, nonsense]\n')
    expect(() => loadPolicy(home)).toThrow(/nonsense/)
  })
})

describe('the policy: the output axis footer', () => {
  it('the footer is on by default', () => {
    expect(loadPolicy(scratch()).output.footer).toBe(true)
  })

  it('it is switched off explicitly', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'output:\n  footer: false\n')
    expect(loadPolicy(dir).output.footer).toBe(false)
  })

  it('a non-boolean value is a load error, not a silent default', () => {
    // A silent default here would mean the human switched the footer off, it
    // stayed on, and they never found out.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'output:\n  footer: no way\n')
    expect(() => loadPolicy(dir)).toThrow(/footer/u)
  })
})

describe('the policy: the exposure valve', () => {
  it('exposure is on by default', () => {
    expect(loadPolicy(scratch()).exposure).toBe(true)
  })

  it('it is switched off explicitly', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'exposure: false\n')
    expect(loadPolicy(dir).exposure).toBe(false)
  })

  it('a non-boolean value is a load error, not a silent default', () => {
    // Same argument as for the footer: the human switched the rule off, it
    // stayed on (or the other way round), and they never found out.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'exposure: off\n')
    expect(() => loadPolicy(dir)).toThrow(/exposure/u)
  })
})

describe('the policy: the task text', () => {
  it('there is no task by default', () => {
    expect(loadPolicy(scratch()).task).toBeNull()
  })

  it('reads the task text', () => {
    // The task is the user-atom source for transports with no user turns
    // (the MCP gateway): what the human named here is what the exposure
    // exemption compares a call's targets against.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'task: change the price of item 99887766\n')
    expect(loadPolicy(dir).task).toBe('change the price of item 99887766')
  })

  it('a non-string task is a load error, not a silent default', () => {
    // A silent default would mean the human wrote the task, it was dropped,
    // and every call under the exposure mark escalated without a word why.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'task: [a, list]\n')
    expect(() => loadPolicy(dir)).toThrow(/task/u)
  })
})

describe('the policy: declaring the source view (toolsReturn)', () => {
  it('the table is empty when nothing is declared', () => {
    expect(loadPolicy(scratch()).toolsReturn).toEqual({})
    expect(DEFAULT_POLICY.toolsReturn).toEqual({})
  })

  it('reads a declaration in both directions', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'policy.yaml'),
      'toolsReturn:\n  mcp__filesystem__read_file: source\n  mcp__browser__open: rendered\n',
    )
    expect(loadPolicy(dir).toolsReturn).toEqual({
      mcp__filesystem__read_file: 'source',
      mcp__browser__open: 'rendered',
    })
  })

  it('an unknown value is a refusal, not a silent default', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn:\n  wb_reviews: sourcecode\n')
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn\.wb_reviews/u)
  })

  it('an empty value is a refusal', () => {
    // A YAML entry with no value gives null. Taking it for a declaration would
    // repeat the story of the empty string in the list of trusted sources.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn:\n  wb_reviews:\n')
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn\.wb_reviews/u)
  })

  it('an empty string as the value is a refusal', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), "toolsReturn:\n  wb_reviews: ''\n")
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn\.wb_reviews/u)
  })

  it('a nested structure as the value is a refusal', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn:\n  wb_reviews:\n    view: source\n')
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn\.wb_reviews/u)
  })

  it('a list as the value is a refusal', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn:\n  wb_reviews: [source]\n')
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn\.wb_reviews/u)
  })

  it('anything but an object in place of the table is a refusal', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn: [mcp__filesystem__read_file]\n')
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn/u)
  })

  it('an empty tool name is a refusal', () => {
    // A name that will match nothing cannot be a declaration: it is a typo,
    // and staying silent about it leaves the human with a policy that does not
    // do what it says.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), "toolsReturn:\n  '': source\n")
    expect(() => loadPolicy(dir)).toThrow(/toolsReturn/u)
  })

  it('a name from the prototype members does not become a declaration on its own', () => {
    // Exactly the case this project has been burned by already:
    // fromPolicy['toString'] once produced a full classification out of the
    // letters of a word. The declaration table is empty, so no name can carry a
    // declaration.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'mode: autonomous\n')
    const policy = loadPolicy(dir)
    expect(Object.hasOwn(policy.toolsReturn, 'toString')).toBe(false)
    expect(Object.hasOwn(policy.toolsReturn, 'constructor')).toBe(false)
  })

  it('__proto__ among the declarations does not change the table prototype', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'toolsReturn:\n  __proto__: rendered\n')
    const policy = loadPolicy(dir)
    expect(({} as Record<string, unknown>)['junk']).toBeUndefined()
    expect(Object.getPrototypeOf(policy.toolsReturn)).not.toBe('rendered')
  })
})

describe('notify', () => {
  it('reads the file the journal is written to', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'notify:\n  file: /tmp/events.jsonl\n')
    expect(loadPolicy(home).notify.file).toBe('/tmp/events.jsonl')
  })

  it('a webhook is a refusal rather than a setting that does nothing', () => {
    // The field used to be read and stored, and nothing ever sent to it: the
    // notifier writes a file or stays silent, and there is no network anywhere
    // in the core by design. An owner who wrote a webhook here believed they
    // were being notified and was not, which is the exact silence autonomous
    // mode exists to prevent.
    const home = scratch()
    writeFileSync(home + '/policy.yaml', 'notify:\n  webhook: https://example.test/hook\n')
    expect(() => loadPolicy(home)).toThrow(/webhook/u)
    expect(() => loadPolicy(home)).toThrow(/notify\.file/u)
  })

  it('a webhook is a refusal even alongside a file that does work', () => {
    const home = scratch()
    writeFileSync(home + '/policy.yaml', 'notify:\n  file: /tmp/e.jsonl\n  webhook: https://example.test/hook\n')
    expect(() => loadPolicy(home)).toThrow(/webhook/u)
  })
})

describe('the policy: memory declarations', () => {
  it('declares nothing extra by default', () => {
    expect(loadPolicy(scratch()).memory).toEqual({ files: [], tools: [] })
  })

  it('reads extra memory files and tools', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'memory:\n  files: [.team-rules]\n  tools: [mem0_add]\n')
    expect(loadPolicy(dir).memory).toEqual({ files: ['.team-rules'], tools: ['mem0_add'] })
  })

  it('a malformed declaration stops the load', () => {
    // A silent default would mean the human declared a memory store and
    // writes into it were never noticed.
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'memory:\n  tools: mem0_add\n')
    expect(() => loadPolicy(dir)).toThrow(/memory\.tools/u)
  })

  it('an empty name is refused', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'policy.yaml'), 'memory:\n  files: [""]\n')
    expect(() => loadPolicy(dir)).toThrow(/memory\.files/u)
  })
})

describe('a key the loader does not know', () => {
  // Every field of the policy defaults to something, so a misspelled key
  // would drop to that default without a word: `exposur: false` leaves the
  // rule on, `memory: {fils: [...]}` leaves a declared store unwatched, a
  // misspelled `notify.file` leaves the owner without the journal they rely
  // on. The policy would not say what its author believes it says.
  const cases: Array<[string, string]> = [
    ['exposur: false\n', 'exposur'],
    ['profile:\n  efects: [read]\n', 'profile.efects'],
    ['profile:\n  resources:\n    host: [example.com]\n', 'profile.resources.host'],
    ['notify:\n  fle: /tmp/events.jsonl\n', 'notify.fle'],
    ['memory:\n  fils: [NOTES.md]\n', 'memory.fils'],
    ['output:\n  foter: false\n', 'output.foter'],
  ]

  for (const [yaml, key] of cases) {
    it(`stops the load on ${key}`, () => {
      const home = scratch()
      writeFileSync(join(home, 'policy.yaml'), yaml)
      expect(() => loadPolicy(home)).toThrow(new RegExp(`unknown key ${key.replaceAll('.', '\\.')}\\b`))
    })
  }

  it('names the keys it does know', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'exposur: false\n')
    expect(() => loadPolicy(home)).toThrow(/exposure/)
  })

  it('does not take a tool name under tools for a misspelled field', () => {
    // The keys under tools and toolsReturn are names the owner chooses.
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'tools:\n  anything_at_all: [read]\ntoolsReturn:\n  whatever: source\n')
    expect(loadPolicy(home).tools['anything_at_all']).toEqual(['read'])
  })
})

describe('mcp.pin', () => {
  it('is on by default', () => {
    expect(loadPolicy(scratch()).mcp.pin).toBe(true)
  })

  it('can be switched off', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'mcp:\n  pin: false\n')
    expect(loadPolicy(home).mcp.pin).toBe(false)
  })

  it('a value that is not a boolean stops the load', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'mcp:\n  pin: "no"\n')
    expect(() => loadPolicy(home)).toThrow(/mcp\.pin must be true or false/u)
  })
})

describe('notify.file', () => {
  // The quickstart wrote `file: ~/.cordon/events.jsonl`, and nothing expanded
  // the tilde: the journal went to a directory literally named `~` inside
  // whatever project the agent ran in — not where the owner looked, and one
  // `git add .` away from the repository.
  it('a leading tilde is the user home', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'notify:\n  file: ~/.cordon/events.jsonl\n')
    expect(loadPolicy(home).notify.file).toBe(join(homedir(), '.cordon', 'events.jsonl'))
  })

  it('a relative path stops the load', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'notify:\n  file: logs/events.jsonl\n')
    expect(() => loadPolicy(home)).toThrow(/notify\.file must be an absolute path/u)
  })

  it('a value that is not a string stops the load', () => {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), 'notify:\n  file: 42\n')
    expect(() => loadPolicy(home)).toThrow(/notify\.file/u)
  })
})

describe('the policy: argument roles and the task mandate', () => {
  function load(yaml: string) {
    const home = scratch()
    writeFileSync(join(home, 'policy.yaml'), yaml)
    return loadPolicy(home)
  }

  it('reads roles and destinations', () => {
    const policy = load('arguments:\n  send_note:\n    addressee: destination\n    repo_slug: resource\ndestinations:\n  - "*@acme.example"\n')
    expect(policy.arguments['send_note']).toEqual({ addressee: 'destination', repo_slug: 'resource' })
    expect(policy.destinations).toEqual(['*@acme.example'])
  })

  it('an unknown role stops the load', () => {
    expect(() => load('arguments:\n  send_note:\n    to: recipient\n')).toThrow(/destination, resource or content/)
  })

  it('a destination that matches everything stops the load', () => {
    // A bare * would be the exposure rule switched off under another name.
    expect(() => load('destinations:\n  - "*"\n')).toThrow(/matches everything/)
    expect(() => load('destinations:\n  - "**"\n')).toThrow(/matches everything/)
  })

  it('a tool name inherited from the prototype is not a declaration', () => {
    expect(Object.hasOwn(load('arguments: {}\n').arguments, 'toString')).toBe(false)
  })
})
