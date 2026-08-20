import { describe, expect, it } from 'vitest'
import { humanSeesRendered, isSubsetOf } from '../../src/core/types.js'

describe('isSubsetOf', () => {
  it('the empty set is contained in any set', () => {
    expect(isSubsetOf([], ['read'])).toBe(true)
    expect(isSubsetOf([], [])).toBe(true)
  })

  it('a subset is contained', () => {
    expect(isSubsetOf(['read'], ['read', 'create'])).toBe(true)
  })

  it('one extra element breaks containment', () => {
    expect(isSubsetOf(['read', 'financial'], ['read', 'create'])).toBe(false)
  })

  it('a non-empty set is not contained in the empty one', () => {
    expect(isSubsetOf(['read'], [])).toBe(false)
  })
})

describe('humanSeesRendered', () => {
  it('the human sees a web page rendered', () => {
    expect(humanSeesRendered({ kind: 'web' })).toBe(true)
  })

  it('the human sees a file and shell output as source', () => {
    expect(humanSeesRendered({ kind: 'file' })).toBe(false)
    expect(humanSeesRendered({ kind: 'bash' })).toBe(false)
  })

  it('an undeclared tool result counts as source', () => {
    // The default was chosen deliberately: an MCP server that reads files
    // would corrupt their content always and without a trace, whereas a miss
    // takes an attacker and still runs into the two remaining axes. See the
    // comment on the function.
    expect(humanSeesRendered({ kind: 'tool' })).toBe(false)
  })

  it('an MCP tool description stays rendered', () => {
    // A description is never written back anywhere, the human never sees it at
    // all, and cutting the hidden layer out of it spoils nothing.
    expect(humanSeesRendered({ kind: 'mcp-description' })).toBe(true)
  })

  it('a declaration in the policy overrides the default both ways', () => {
    expect(humanSeesRendered({ kind: 'tool', declaredView: 'rendered' })).toBe(true)
    expect(humanSeesRendered({ kind: 'web', declaredView: 'source' })).toBe(false)
    expect(humanSeesRendered({ kind: 'file', declaredView: 'rendered' })).toBe(true)
  })
})
