import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../../src/policy/load.js'
import { PROFILES, renderPolicy } from '../../src/policy/templates.js'

/**
 * `cordon init` writes one of these. Every template must load through the
 * same strict loader as a hand-written policy: a template that failed to
 * load would be a refusal on every event from the first minute.
 */
describe('policy templates', () => {
  for (const name of Object.keys(PROFILES)) {
    it(`${name} loads and says what it grants`, () => {
      const home = mkdtempSync(join(tmpdir(), 'cordon-template-'))
      writeFileSync(join(home, 'policy.yaml'), renderPolicy(name, home))
      const policy = loadPolicy(home)
      expect(policy.profile.effects).toEqual(PROFILES[name]!.effects)
      expect(policy.mode).toBe(PROFILES[name]!.mode)
      expect(policy.notify.file).toBe(join(home, 'events.jsonl'))
      expect(policy.exposure).toBe(true)
    })
  }

  it('the locked profile is the default policy', () => {
    expect(PROFILES['locked']!.effects).toEqual(['read', 'summarize'])
  })

  it('no template grants delete, export or financial', () => {
    // Those are the irreversible classes; granting them is a decision for
    // the owner to write down, not for a template to make.
    for (const profile of Object.values(PROFILES)) {
      expect(profile.effects).not.toContain('delete')
      expect(profile.effects).not.toContain('export')
      expect(profile.effects).not.toContain('financial')
    }
  })

  it('an unknown profile is an error', () => {
    expect(() => renderPolicy('everything', '/tmp')).toThrow(/unknown profile/u)
  })
})
