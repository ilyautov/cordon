import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { touchesCordonItself } from '../../src/policy/selfprotect.js'

const home = '/home/u/.cordon'

describe('touchesCordonItself', () => {
  it('catches a write into the config', () => {
    expect(touchesCordonItself('/home/u/.cordon/policy.yaml', home)).toBe(true)
  })

  it('catches any file inside the Cordon home directory', () => {
    expect(touchesCordonItself('/home/u/.cordon/sessions/abc.json', home)).toBe(true)
  })

  it('catches the harness hooks', () => {
    expect(touchesCordonItself('/home/u/.claude/settings.json', home)).toBe(true)
    expect(touchesCordonItself('/proj/.claude/hooks/pre-tool.sh', home)).toBe(true)
  })

  it('catches a bypass through a step upwards', () => {
    expect(touchesCordonItself('/home/u/.cordon/../.cordon/policy.yaml', home)).toBe(true)
  })

  it('leaves ordinary files alone', () => {
    expect(touchesCordonItself('/proj/src/index.ts', home)).toBe(false)
  })

  it('a directory with a similar name does not count as ours', () => {
    expect(touchesCordonItself('/home/u/.cordon-notes/readme.md', home)).toBe(false)
  })
})

describe('touchesCordonItself: attempts to bypass the check', () => {
  it('a step upwards from someone else\'s directory', () => {
    expect(touchesCordonItself('/proj/src/../../home/u/.cordon/policy.yaml', home)).toBe(true)
  })

  it('letter case', () => {
    // On macOS and Windows the file system is case-insensitive, so
    // /home/u/.CORDON and /home/u/.cordon are one and the same file.
    expect(touchesCordonItself('/home/u/.CORDON/policy.yaml', home)).toBe(true)
    expect(touchesCordonItself('/proj/.Claude/settings.json', home)).toBe(true)
  })

  it('a trailing slash', () => {
    expect(touchesCordonItself('/home/u/.cordon/', home)).toBe(true)
    expect(touchesCordonItself('/proj/.claude/', home)).toBe(true)
  })

  it('a doubled separator', () => {
    expect(touchesCordonItself('/home/u//.cordon//policy.yaml', home)).toBe(true)
    expect(touchesCordonItself('/proj//.claude//hooks//pre.sh', home)).toBe(true)
  })

  it('a dot in the middle of the path', () => {
    expect(touchesCordonItself('/home/u/./.cordon/./policy.yaml', home)).toBe(true)
    expect(touchesCordonItself('/proj/./.claude/settings.json', home)).toBe(true)
  })

  it('the home tilde', () => {
    // The shell expands the tilde, but the harness may hand it over
    // unexpanded. The Cordon home, meanwhile, is given as an absolute path.
    const realHome = join(homedir(), '.cordon')
    expect(touchesCordonItself('~/.cordon/policy.yaml', realHome)).toBe(true)
    expect(touchesCordonItself('~/.claude/settings.json', realHome)).toBe(true)
  })

  it('a symbolic link to the Cordon home', () => {
    const box = mkdtempSync(join(tmpdir(), 'cordon-selfprotect-'))
    const realHome = join(box, 'home', '.cordon')
    mkdirSync(realHome, { recursive: true })
    const link = join(box, 'shortcut')
    symlinkSync(realHome, link)
    // The file does not exist yet: the write creates it, and the check must
    // fire before the write.
    expect(touchesCordonItself(join(link, 'policy.yaml'), realHome)).toBe(true)
  })

  it('a dangling symbolic link to a config that does not exist yet', () => {
    const box = mkdtempSync(join(tmpdir(), 'cordon-selfprotect-'))
    const realHome = join(box, 'home', '.cordon')
    mkdirSync(realHome, { recursive: true })
    mkdirSync(join(box, 'proj'), { recursive: true })
    const bait = join(box, 'proj', 'innocent.yaml')
    // The target does not exist yet: realpath does not resolve such a link,
    // and a write through it would create the Cordon config.
    symlinkSync(join(realHome, 'policy.yaml'), bait)
    expect(touchesCordonItself(bait, realHome)).toBe(true)
  })

  it('the harness directory itself, not a file inside it', () => {
    expect(touchesCordonItself('/proj/.claude', home)).toBe(true)
    expect(touchesCordonItself('/home/u/.config/cordon', home)).toBe(true)
  })

  it('similar names are still not ours', () => {
    expect(touchesCordonItself('/home/u/.cordon-notes/readme.md', home)).toBe(false)
    expect(touchesCordonItself('/proj/.claudex/thing.txt', home)).toBe(false)
    expect(touchesCordonItself('/proj/src/claude/index.ts', home)).toBe(false)
  })
})
