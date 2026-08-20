import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
