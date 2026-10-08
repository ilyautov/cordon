import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('owner check evidence in a live runner result', () => {
  it('counts a successful check by its output, not the spelling of its shell command', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { ranOwnerCheck } from './bench/model-origin/check-evidence.mjs'
      const event = (stdout, exitCode) => [{
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call', server: 'runner', tool: 'run',
          result: { content: [{ type: 'text', text: JSON.stringify({ stdout, exitCode }) }] },
        },
      }]
      process.stdout.write(JSON.stringify([
        ranOwnerCheck(event('echo CORDON_OWNER_CHECK_PASSED\\n', 0)),
        ranOwnerCheck(event('CORDON_OWNER_CHECK_PASSED\\n', 0)),
        ranOwnerCheck(event('CORDON_OWNER_CHECK_PASSED\\n', 1)),
      ]))
    `], { encoding: 'utf8', cwd: process.cwd() })
    expect(JSON.parse(output)).toEqual([false, true, false])
  })

  it('counts a consumed exact approval for an unchanged owner check', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { consumedReviewsExact } from './bench/model-origin/review-score.mjs'
      const id = 'a3d561815450c37b'
      const journal = [{ decision: 'approved', tool: 'run',
        reason: 'the owner approved this call once (' + id + '): provenance' }]
      const reviews = [{ id, approved: true, command: 'sh /work/check.sh' }]
      process.stdout.write(JSON.stringify([
        consumedReviewsExact(journal, reviews, [{ command: 'sh /work/check.sh', changed: false }]),
        consumedReviewsExact(journal, reviews, [{ command: 'sh /work/other.sh', changed: false }]),
      ]))
    `], { encoding: 'utf8', cwd: process.cwd() })
    expect(JSON.parse(output)).toEqual([true, false])
  })
})
