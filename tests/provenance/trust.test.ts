import { describe, expect, it } from 'vitest'
import { classifySource } from '../../src/provenance/trust.js'
import { DEFAULT_POLICY } from '../../src/policy/defaults.js'
import type { Policy } from '../../src/policy/defaults.js'

const policy = DEFAULT_POLICY

function trusting(...sources: string[]): Policy {
  return { ...structuredClone(DEFAULT_POLICY), trustedSources: sources }
}

describe('classifySource', () => {
  it('a user message is trusted', () => {
    expect(classifySource({ kind: 'user', label: 'prompt' }, policy).trust).toBe('trusted')
  })

  it('the system prompt is trusted', () => {
    expect(classifySource({ kind: 'system', label: 'system' }, policy).trust).toBe('trusted')
  })

  it('the web is untrusted', () => {
    expect(classifySource({ kind: 'web', label: 'https://example.com' }, policy).trust).toBe('untrusted')
  })

  it('an MCP tool description is untrusted', () => {
    expect(classifySource({ kind: 'mcp-description', label: 'wb_reply' }, policy).trust).toBe('untrusted')
  })

  it('a tool result is untrusted', () => {
    expect(classifySource({ kind: 'tool', label: 'wb_reply' }, policy).trust).toBe('untrusted')
  })

  it('Bash output is untrusted', () => {
    expect(classifySource({ kind: 'bash', label: 'cat README.md' }, policy).trust).toBe('untrusted')
  })

  it('a file is untrusted', () => {
    expect(classifySource({ kind: 'file', label: '/proj/CLAUDE.md' }, policy).trust).toBe('untrusted')
  })

  it('an explicitly declared source becomes trusted', () => {
    expect(classifySource({ kind: 'web', label: 'https://docs.internal/api' }, trusting('https://docs.internal/')).trust).toBe('trusted')
  })

  it('a similar prefix grants no trust', () => {
    expect(classifySource({ kind: 'web', label: 'https://docs.internal.evil.example/a' }, trusting('https://docs.internal/')).trust).toBe('untrusted')
  })

  it('a forgotten slash in the declaration does not open a neighbouring domain', () => {
    const p = trusting('https://docs.internal')
    expect(classifySource({ kind: 'web', label: 'https://docs.internal.evil.example/a' }, p).trust).toBe('untrusted')
    expect(classifySource({ kind: 'web', label: 'https://docs.internal/api' }, p).trust).toBe('trusted')
  })

  it('yields a stable identifier for one and the same source', () => {
    const a = classifySource({ kind: 'web', label: 'https://example.com' }, policy)
    const b = classifySource({ kind: 'web', label: 'https://example.com' }, policy)
    expect(a.id).toBe(b.id)
  })

  it('different sources get different identifiers', () => {
    const a = classifySource({ kind: 'web', label: 'https://example.com' }, policy)
    const b = classifySource({ kind: 'web', label: 'https://other.example' }, policy)
    expect(a.id).not.toBe(b.id)
  })

  it('the source kind is part of the identifier', () => {
    const a = classifySource({ kind: 'web', label: 'README.md' }, policy)
    const b = classifySource({ kind: 'file', label: 'README.md' }, policy)
    expect(a.id).not.toBe(b.id)
  })

  it('the core decides the label, not what the adapter brought', () => {
    // The adapter reports where the text came from but does not decide
    // whether to trust it. Otherwise the rule lives in every adapter
    // separately and differently in each.
    const origin = { kind: 'web' as const, label: 'https://example.com', trust: 'trusted' }
    expect(classifySource(origin, policy).trust).toBe('untrusted')
  })
})

describe('classifySource: a trust declaration must not open more than it says', () => {
  it('an empty string in the list makes nothing trusted', () => {
    // A bare startsWith with an empty prefix, once the separator is
    // appended, turns into "we trust any absolute path".
    const p = trusting('')
    expect(classifySource({ kind: 'file', label: '/etc/passwd' }, p).trust).toBe('untrusted')
    expect(classifySource({ kind: 'web', label: 'https://evil.example' }, p).trust).toBe('untrusted')
  })

  it('a whitespace string in the list does not count either', () => {
    expect(classifySource({ kind: 'file', label: '/etc/passwd' }, trusting('  ')).trust).toBe('untrusted')
  })

  it('a non-string list item neither crashes nor opens anything', () => {
    const p = { ...structuredClone(DEFAULT_POLICY), trustedSources: [42, null, '/srv/docs/'] as unknown as string[] }
    expect(classifySource({ kind: 'file', label: '/etc/passwd' }, p).trust).toBe('untrusted')
    expect(classifySource({ kind: 'file', label: '/srv/docs/a.md' }, p).trust).toBe('trusted')
  })

  it('a list of the wrong type is the absence of trust, not an exception', () => {
    const p = { ...structuredClone(DEFAULT_POLICY), trustedSources: '/srv/docs/' as unknown as string[] }
    expect(classifySource({ kind: 'file', label: '/srv/docs/a.md' }, p).trust).toBe('untrusted')
  })

  it('directory climbing does not lead out of a trusted root', () => {
    const p = trusting('/srv/docs/')
    expect(classifySource({ kind: 'file', label: '/srv/docs/a.md' }, p).trust).toBe('trusted')
    expect(classifySource({ kind: 'file', label: '/srv/docs/../../root/.ssh/id_rsa' }, p).trust).toBe('untrusted')
    expect(classifySource({ kind: 'file', label: '/srv/docs/..\\..\\secret' }, p).trust).toBe('untrusted')
  })

  it('climbing written in percent-encoding does not pass either', () => {
    const p = trusting('https://docs.internal/')
    expect(classifySource({ kind: 'web', label: 'https://docs.internal/%2e%2e/%2e%2e/etc' }, p).trust).toBe('untrusted')
    expect(classifySource({ kind: 'web', label: 'https://docs.internal/.%2E/secret' }, p).trust).toBe('untrusted')
  })

  it('two dots inside a file name do not count as climbing', () => {
    const p = trusting('/srv/docs/')
    expect(classifySource({ kind: 'file', label: '/srv/docs/report..draft.md' }, p).trust).toBe('trusted')
  })

  it('a label exactly equal to the declaration is trusted', () => {
    expect(classifySource({ kind: 'file', label: '/srv/docs' }, trusting('/srv/docs')).trust).toBe('trusted')
  })

  it('a neighbouring directory sharing the start of the name is untrusted', () => {
    expect(classifySource({ kind: 'file', label: '/srv/docs-secret/x' }, trusting('/srv/docs')).trust).toBe('untrusted')
  })

  it('a login in a link does not pass itself off as a trusted host', () => {
    const p = trusting('https://docs.internal/')
    expect(classifySource({ kind: 'web', label: 'https://docs.internal@evil.example/a' }, p).trust).toBe('untrusted')
    expect(classifySource({ kind: 'web', label: 'https://evil.example/?u=https://docs.internal/' }, p).trust).toBe('untrusted')
  })

  it('an empty label gets no trust', () => {
    expect(classifySource({ kind: 'web', label: '' }, trusting('https://docs.internal/')).trust).toBe('untrusted')
  })

  it('a trust declaration does not touch user and system: they are trusted anyway', () => {
    expect(classifySource({ kind: 'user', label: 'anything at all' }, trusting('/srv/')).trust).toBe('trusted')
  })
})

function declaring(table: Record<string, unknown>): Policy {
  return { ...structuredClone(DEFAULT_POLICY), toolsReturn: table as unknown as Policy['toolsReturn'] }
}

describe('classifySource: the source view comes from the declaration', () => {
  it('without a declaration there is no view', () => {
    const source = classifySource({ kind: 'tool', label: 'reviews', tool: 'mcp__wb__reviews' }, policy)
    expect(source.declaredView).toBeUndefined()
  })

  it('a declared source view reaches the source', () => {
    const source = classifySource(
      { kind: 'tool', label: '/proj/index.html', tool: 'mcp__filesystem__read_file' },
      declaring({ mcp__filesystem__read_file: 'source' }),
    )
    expect(source.declaredView).toBe('source')
  })

  it('a declared rendered view reaches it too', () => {
    const source = classifySource(
      { kind: 'tool', label: 'https://shop.example', tool: 'mcp__browser__open' },
      declaring({ mcp__browser__open: 'rendered' }),
    )
    expect(source.declaredView).toBe('rendered')
  })

  it('the declaration is looked up by tool name, not by source label', () => {
    // The label is a path or a link from the call's arguments, and it need
    // not coincide with the tool name at all.
    const source = classifySource(
      { kind: 'tool', label: '/proj/index.html', tool: 'mcp__filesystem__read_file' },
      declaring({ '/proj/index.html': 'rendered' }),
    )
    expect(source.declaredView).toBeUndefined()
  })

  it('a tool name taken from the prototype members yields no declaration', () => {
    // The MCP server chooses the name. Direct indexing would yield a
    // declaration made of the letters of the word: fromPolicy['toString']
    // has already done exactly that once.
    for (const name of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const source = classifySource({ kind: 'tool', label: 'x', tool: name }, policy)
      expect(source.declaredView, name).toBeUndefined()
    }
  })

  it('a value outside the two known ones does not count as a declaration', () => {
    // The loader validates the policy, but the core does not rely on having
    // been called through the loader: Policy is assembled by tests and by
    // calling code too.
    for (const value of ['sourcetext', '', 'RENDERED', 0, null, {}, ['source']]) {
      const source = classifySource(
        { kind: 'tool', label: 'x', tool: 'wb_reviews' },
        declaring({ wb_reviews: value }),
      )
      expect(source.declaredView, JSON.stringify(value)).toBeUndefined()
    }
  })

  it('a table that is not an object yields no declarations', () => {
    for (const table of [null, 'source', ['wb_reviews'], 42]) {
      const source = classifySource(
        { kind: 'tool', label: 'x', tool: 'wb_reviews' },
        { ...structuredClone(DEFAULT_POLICY), toolsReturn: table as unknown as Policy['toolsReturn'] },
      )
      expect(source.declaredView, JSON.stringify(table)).toBeUndefined()
    }
  })

  it('an empty tool name looks up no declaration', () => {
    const source = classifySource(
      { kind: 'tool', label: 'x', tool: '' },
      declaring({ '': 'rendered' }),
    )
    expect(source.declaredView).toBeUndefined()
  })

  it('a view declaration does not change the trust label', () => {
    const source = classifySource(
      { kind: 'tool', label: 'reviews', tool: 'mcp__wb__reviews' },
      declaring({ mcp__wb__reviews: 'rendered' }),
    )
    expect(source.trust).toBe('untrusted')
  })

  it("the source identifier does not drift because of a declaration", () => {
    // Otherwise one and the same source would look like two different ones
    // before and after the declaration, and the previous turn's provenance
    // would not be found.
    const bare = classifySource({ kind: 'tool', label: 'reviews', tool: 'mcp__wb__reviews' }, policy)
    const declared = classifySource(
      { kind: 'tool', label: 'reviews', tool: 'mcp__wb__reviews' },
      declaring({ mcp__wb__reviews: 'rendered' }),
    )
    expect(declared.id).toBe(bare.id)
  })
})
