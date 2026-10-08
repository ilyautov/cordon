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
})
