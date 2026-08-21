import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeDirectory } from '../../src/core/mkdir.js'

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-mkdir-'))
}

describe('makeDirectory', () => {
  it('creates every missing level', () => {
    const dir = join(temp(), 'a', 'b', 'c')
    makeDirectory(dir)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('an existing directory is not an error', () => {
    const dir = temp()
    makeDirectory(dir)
    expect(existsSync(dir)).toBe(true)
  })

  it('what it creates is readable by its owner alone', () => {
    const dir = join(temp(), 'sessions')
    makeDirectory(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('a mode can be asked for', () => {
    const dir = join(temp(), 'journal')
    makeDirectory(dir, 0o755)
    expect(statSync(dir).mode & 0o777).toBe(0o755)
  })

  it('a file standing where a directory has to be throws rather than blocks', () => {
    // This is the whole reason the helper exists. mkdirSync's recursive mode
    // does not always come back — under /proc on Linux it blocks forever —
    // and a hook that never returns is read as permission to proceed.
    const file = join(temp(), 'a-file')
    writeFileSync(file, 'x')
    expect(() => makeDirectory(join(file, 'sessions'))).toThrow(/ENOTDIR/)
  })

  it('relative paths are built too', () => {
    const dir = temp()
    process.chdir(dir)
    makeDirectory(join('one', 'two'))
    expect(statSync(join(dir, 'one', 'two')).isDirectory()).toBe(true)
  })
})
