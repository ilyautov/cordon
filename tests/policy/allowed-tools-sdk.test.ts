import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cordon, DEFAULT_POLICY, type Policy } from '../../src/index.js'
import { explain } from '../../src/policy/explain.js'

function cordonFor(policy: Policy): Cordon {
  const cordonHome = mkdtempSync(join(tmpdir(), 'cordon-allowed-tools-'))
  return new Cordon({ policy, cordonHome })
}

const read = { tool: 'Read', args: { file_path: 'notes.txt' } }

describe('Cordon: tool allowlists in the public policy API', () => {
  it('accepts a policy created before the allowlist existed', () => {
    const { allowedTools: _allowedTools, ...policy } = structuredClone(DEFAULT_POLICY)

    expect(cordonFor(policy).gate(read)).toEqual({ kind: 'allow' })
  })

  it('explains a legacy policy without an allowlist', () => {
    const { allowedTools: _allowedTools, ...policy } = structuredClone(DEFAULT_POLICY)

    expect(explain(policy).join('\n')).not.toContain('Allowed tools:')
  })

  it('accepts an explicit null allowlist', () => {
    const policy = { ...structuredClone(DEFAULT_POLICY), allowedTools: null }

    expect(cordonFor(policy).gate(read)).toEqual({ kind: 'allow' })
  })

  it('refuses every tool without an approval when the allowlist is empty', () => {
    const policy = { ...structuredClone(DEFAULT_POLICY), allowedTools: [] }
    const decision = cordonFor(policy).gateUnattended(read)

    expect(decision).toMatchObject({ kind: 'deny', rule: 'tool-not-allowed' })
    expect(decision).not.toHaveProperty('approvalId')
  })

  it.each([
    { declaration: 'Read' },
    { declaration: ['Read', null] },
    { declaration: ['Read', ' '] },
    { declaration: Object.assign(new Array<string>(2), { 0: 'Read' }) },
  ])('fails closed for a malformed allowlist ($declaration)', ({ declaration }) => {
    const policy = {
      ...structuredClone(DEFAULT_POLICY),
      allowedTools: declaration as unknown as Policy['allowedTools'],
    }

    expect(cordonFor(policy).gate(read)).toMatchObject({ kind: 'deny' })
  })
})
