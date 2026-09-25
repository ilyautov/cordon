import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('the package', () => {
  it('exports the version it is published under', () => {
    // A library that reports a version other than the one installed sends a
    // bug report to the wrong release.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('declares the cordon command in the form npm keeps on publish', () => {
    // npm 11 drops a bin entry spelled "./dist/cli.js" at publish time, with
    // only a warning: the package goes out without its command, and
    // `npx cordon` stops working for everyone who installs it.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> }
    expect(pkg.bin).toEqual({ cordon: 'dist/cli.js' })
  })
})
