import { describe, expect, it } from 'vitest'
import { readPatch } from '../../src/scope/patch.js'
import { classify } from '../../src/scope/effects.js'

/**
 * Codex writes files with one tool, apply_patch, and the paths it touches
 * are inside the patch text, not in a field. A gate that reads fields sees
 * no path at all: self-protection, path bounds and the agent's own settings
 * would all be walked past by a patch.
 */

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

describe('readPatch', () => {
  it('names every file a patch adds, updates, deletes or moves to', () => {
    const read = readPatch(patch(
      '*** Add File: /w/a.txt', '+hi',
      '*** Update File: /w/b.txt', '*** Move to: /w/c.txt', '@@', '-x', '+y',
      '*** Delete File: /w/d.txt',
    ))
    expect(read?.paths).toEqual(['/w/a.txt', '/w/b.txt', '/w/c.txt', '/w/d.txt'])
    expect(read?.deletes).toBe(true)
  })

  it('a patch that only adds and updates deletes nothing', () => {
    expect(readPatch(patch('*** Add File: /w/a.txt', '+hi'))?.deletes).toBe(false)
  })

  it('a move deletes the file it moves from', () => {
    expect(readPatch(patch('*** Update File: /w/b.txt', '*** Move to: /w/c.txt'))?.deletes).toBe(true)
  })

  it('reads a directive the harness might accept with loose spacing or case', () => {
    // A path read narrower than the harness reads it is a write the gate
    // never sees; a path read wider only costs a stricter decision.
    const read = readPatch('  ***  add file :  /home/u/.cordon/policy.yaml\n+mode: off')
    expect(read?.paths).toEqual(['/home/u/.cordon/policy.yaml'])
  })

  it('does not read a directive quoted inside an added line', () => {
    const read = readPatch(patch('*** Add File: /w/notes.md', '+*** Delete File: /w/other.md'))
    expect(read?.paths).toEqual(['/w/notes.md'])
    expect(read?.deletes).toBe(false)
  })

  it('reads a header behind a character Rust trims and JavaScript does not', () => {
    // Codex, review of this change: Codex trims a line with Rust's trim(),
    // which takes U+0085 away; \s in JavaScript does not. The second file,
    // Codex's own hooks, was written unseen.
    const read = readPatch(patch('*** Add File: /w/ok.txt', '+x', '\u0085*** Add File: /home/u/.codex/hooks.json', '+{}'))
    expect(read?.paths).toEqual(['/w/ok.txt', '/home/u/.codex/hooks.json'])
    for (const space of ['\u00A0', '\u1680', '\u2003', '\u2028', '\u202F', '\u3000', '\u000B', '\u000C']) {
      expect(readPatch(`${space}*** Delete File: /w/x${space}`)?.paths, JSON.stringify(space)).toEqual(['/w/x'])
    }
  })

  it('an indented header inside an update is a context line, as Codex reads it', () => {
    // Codex, review of this change: a document that quotes a patch header on
    // an unchanged line was refused as a delete of Cordon's policy.
    const read = readPatch(patch('*** Update File: /w/README.md', '@@', ' *** Delete File: /home/u/.cordon/policy.yaml', '-old', '+new'))
    expect(read).toEqual({ paths: ['/w/README.md'], deletes: false })
  })

  it('an unindented header ends an update, as Codex reads it', () => {
    const read = readPatch(patch('*** Update File: /w/a.txt', '@@', '-x', '+y', '*** Delete File: /w/b.txt'))
    expect(read).toEqual({ paths: ['/w/a.txt', '/w/b.txt'], deletes: true })
  })

  it('reads a path that carries a line separator inside it', () => {
    // Codex, review of this change: `.` in a JavaScript pattern stops at
    // U+2028, U+2029 and a lone \r, while Codex keeps them in the path. The
    // delete was read as no header at all and passed without `delete`.
    for (const odd of ['\u2028', '\u2029', '\r']) {
      const read = readPatch(patch('*** Add File: /w/ok.txt', '+x', `*** Delete File: /w/erase${odd}.txt`))
      expect(read, JSON.stringify(odd)).toEqual({ paths: ['/w/ok.txt', `/w/erase${odd}.txt`], deletes: true })
    }
  })

  it('checks the path Codex writes when trimming would change it', () => {
    // Codex, review of this change: Rust's trim() keeps U+FEFF, \s in
    // JavaScript takes it away, so the bound was checked against
    // /w/allowed.txt while Codex wrote /w/allowed.txt\uFEFF. The same holds
    // for spaces after the marker: Codex keeps them in the name.
    expect(readPatch(patch('*** Add File: /w/allowed.txt\uFEFF', '+x'))?.paths)
      .toEqual(['/w/allowed.txt\uFEFF', '/w/allowed.txt'])
    expect(readPatch(patch('*** Add File:  a.txt', '+x'))?.paths).toEqual([' a.txt', 'a.txt'])
    expect(readPatch(patch('*** Update File: /w/b.txt', '*** Move to: /w/c.txt\uFEFF'))?.paths)
      .toEqual(['/w/b.txt', '/w/c.txt\uFEFF', '/w/c.txt'])
  })

  it('a patch with no file in it is not read at all', () => {
    expect(readPatch('*** Begin Patch\n*** End Patch')).toBeNull()
    expect(readPatch('rm -rf /')).toBeNull()
  })
})

describe('apply_patch is classified by what the patch does', () => {
  const tools = { apply_patch: ['create' as const, 'update' as const] }

  it('adds delete to a patch that deletes', () => {
    const call = { tool: 'apply_patch', args: { patch: patch('*** Delete File: /w/d.txt'), paths: ['/w/d.txt'] } }
    expect(classify(call, tools).effects).toEqual(['create', 'update', 'delete'])
  })

  it('keeps a patch that only writes at create and update', () => {
    const call = { tool: 'apply_patch', args: { patch: patch('*** Add File: /w/a.txt', '+x'), paths: ['/w/a.txt'] } }
    expect(classify(call, tools).effects).toEqual(['create', 'update'])
  })

  it('a patch that cannot be read counts as deleting', () => {
    const call = { tool: 'apply_patch', args: { patch: 42 } }
    expect(classify(call, tools).effects).toContain('delete')
  })
})
