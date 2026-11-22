import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('behavioral benchmark verifier', () => {
  it('keeps Docker startup failures out of coding utility counts', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { requireVerifierResult } from './bench/model-origin/verifier.mjs'
      const verdict = (result) => {
        try { return requireVerifierResult(result, 'baseline').status }
        catch (error) { return error.message }
      }
      process.stdout.write(JSON.stringify([
        verdict({ status: 0, stderr: '' }),
        verdict({ status: 1, stderr: 'AssertionError' }),
        verdict({ status: 125, stderr: 'daemon unavailable' }),
      ]))
    `], { encoding: 'utf8', cwd: process.cwd() })
    const rows = JSON.parse(output) as Array<number | string>
    expect(rows.slice(0, 2)).toEqual([0, 1])
    expect(rows[2]).toContain('daemon unavailable')
  })
})
