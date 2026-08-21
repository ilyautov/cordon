import { describe, expect, it } from 'vitest'
import { classify } from '../../src/scope/effects.js'
import type { EffectClass } from '../../src/core/types.js'

const fromPolicy: Record<string, EffectClass[]> = { wb_update_price: ['update', 'financial'] }
const wideBash: Record<string, EffectClass[]> = { Bash: ['exec', 'network-egress'] }

describe('classify', () => {
  it('knows the harness built-in tools', () => {
    expect(classify({ tool: 'Read', args: {} }, {}).effects).toEqual(['read'])
    expect(classify({ tool: 'WebFetch', args: {} }, {}).effects).toEqual(['read', 'network-egress'])
    expect(classify({ tool: 'Edit', args: {} }, {}).effects).toEqual(['update'])
  })

  // Measured on Claude Code 2.1.236: with ToolSearch unclassified, a session
  // whose profile was read and summarize could not reach WebFetch at all, and
  // the journal recorded the refusal against ToolSearch rather than against
  // anything the model wanted to do. The narrowest profile there is has to be
  // able to look up a schema.
  it('looking a tool up is a read, so the narrowest profile still allows it', () => {
    const verdict = classify({ tool: 'ToolSearch', args: { query: 'select:Read' } }, {})
    expect(verdict.classified).toBe(true)
    expect(verdict.effects).toEqual(['read'])
  })

  it('Bash is exec, not read', () => {
    const verdict = classify({ tool: 'Bash', args: { command: 'ls' } }, {})
    expect(verdict.effects).toEqual(['exec'])
  })

  it('takes the classes from the policy for MCP tools', () => {
    const verdict = classify({ tool: 'wb_update_price', args: {} }, fromPolicy)
    expect(verdict.classified).toBe(true)
    expect(verdict.effects).toEqual(['update', 'financial'])
  })

  it('an unfamiliar tool stays unclassified', () => {
    const verdict = classify({ tool: 'some_mcp_thing', args: {} }, {})
    expect(verdict.classified).toBe(false)
    expect(verdict.effects).toEqual([])
    expect(verdict.reason).toContain('some_mcp_thing')
  })

  it('the policy overrides the built-in table', () => {
    const verdict = classify({ tool: 'Bash', args: {} }, wideBash)
    expect(verdict.effects).toEqual(['exec', 'network-egress'])
  })
})

describe('classify: a tool name must not reach the prototype', () => {
  // The tool name comes from an MCP server, that is, it is chosen by the
  // attacker. An ordinary key lookup would return an inherited member of
  // Object.prototype, and an unfamiliar tool would come out "classified".
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf'])(
    '%s stays unclassified',
    (name) => {
      const verdict = classify({ tool: name, args: {} }, {})
      expect(verdict.classified).toBe(false)
      expect(verdict.effects).toEqual([])
    },
  )

  it('garbage in place of an effect list does not pass for a classification', () => {
    const broken = { evil_tool: 'exec' } as unknown as Record<string, EffectClass[]>
    expect(classify({ tool: 'evil_tool', args: {} }, broken).classified).toBe(false)
  })
})
