import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryTarget } from '../../src/gate/memory.js'
import { DEFAULT_POLICY, type Policy } from '../../src/policy/defaults.js'

function policy(memory: Policy['memory'] = { files: [], tools: [] }): Policy {
  return { ...structuredClone(DEFAULT_POLICY), memory }
}

describe('memoryTarget: which calls write into memory an agent reloads', () => {
  it('a Write to a CLAUDE.md is a memory write', () => {
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/CLAUDE.md', content: 'x' } }, policy()))
      .toBe('/srv/p/CLAUDE.md')
  })

  it('an Edit to AGENTS.md or GEMINI.md is a memory write', () => {
    expect(memoryTarget({ tool: 'Edit', args: { file_path: '/srv/p/AGENTS.md' } }, policy())).toBe('/srv/p/AGENTS.md')
    expect(memoryTarget({ tool: 'Edit', args: { file_path: '/srv/p/GEMINI.md' } }, policy())).toBe('/srv/p/GEMINI.md')
  })

  it('the name is compared case-folded', () => {
    // macOS and Windows open CLAUDE.md for claude.md: a spelling the page
    // chooses must not decide whether the write is noticed.
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/claude.md' } }, policy())).toBe('/srv/p/claude.md')
  })

  it('reading a memory file is not a write', () => {
    expect(memoryTarget({ tool: 'Read', args: { file_path: '/srv/p/CLAUDE.md' } }, policy())).toBeNull()
  })

  it('an ordinary file is not memory', () => {
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/NOTES.md' } }, policy())).toBeNull()
  })

  it('a name that merely contains a memory file name is not memory', () => {
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/OLD-CLAUDE.md' } }, policy())).toBeNull()
  })

  it('the Gemini CLI memory tool is a memory write', () => {
    expect(memoryTarget({ tool: 'save_memory', args: { fact: 'x' } }, policy())).toBe('save_memory')
  })

  it('a memory tool declared in the policy is a memory write', () => {
    // A Mem0 store behind LangChain is an ordinary tool call to Cordon; only
    // the human who wired it knows it outlives the session.
    const declared = policy({ files: [], tools: ['mem0_add'] })
    const withEffects = { ...declared, tools: { mem0_add: ['create' as const] } }
    expect(memoryTarget({ tool: 'mem0_add', args: { text: 'x' } }, withEffects)).toBe('mem0_add')
  })

  it('a memory file name declared in the policy is a memory write', () => {
    const declared = policy({ files: ['.cursorrules-team'], tools: [] })
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/.cursorrules-team' } }, declared))
      .toBe('/srv/p/.cursorrules-team')
  })

  it('a tool named like a prototype member is not a memory tool', () => {
    expect(memoryTarget({ tool: 'toString', args: {} }, policy())).toBeNull()
  })

  it('a trailing dot or space does not hide the name', () => {
    // macOS and Windows open CLAUDE.md for "CLAUDE.md." and "CLAUDE.md " —
    // the same spelling trick selfprotect already folds away.
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/CLAUDE.md ' } }, policy())).not.toBeNull()
    expect(memoryTarget({ tool: 'Write', args: { file_path: '/srv/p/CLAUDE.md.' } }, policy())).not.toBeNull()
  })

  it('a path nested inside the arguments is seen', () => {
    // An MCP tool wraps its path one level down as often as not; the gate
    // walks the whole tree, and so must this.
    const declared = { ...policy(), tools: { doc_write: ['update' as const] } }
    expect(memoryTarget({ tool: 'doc_write', args: { document: { path: '/srv/p/AGENTS.md' } } }, declared))
      .not.toBeNull()
  })

  it('a link to a memory file is a write into it', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cordon-memory-link-')))
    writeFileSync(join(dir, 'CLAUDE.md'), 'notes')
    symlinkSync(join(dir, 'CLAUDE.md'), join(dir, 'notes.md'))
    expect(memoryTarget({ tool: 'Write', args: { file_path: join(dir, 'notes.md') } }, policy()))
      .toBe(join(dir, 'CLAUDE.md'))
  })

  it('a tilde path is reported as the file it names', () => {
    expect(memoryTarget({ tool: 'Write', args: { file_path: '~/proj/CLAUDE.md' } }, policy()))
      .toBe(join(homedir(), 'proj', 'CLAUDE.md'))
  })
})
