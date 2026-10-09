import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('distinct-UID benchmark process waiting', () => {
  it('returns an explicit timeout when a child never closes', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { EventEmitter } from 'node:events'
      import { waitChildClose } from './bench/model-origin/uid-codex-wait-child.mjs'
      const hanging = new EventEmitter()
      hanging.exitCode = null
      hanging.signalCode = null
      const settled = new EventEmitter()
      settled.exitCode = null
      settled.signalCode = null
      setTimeout(() => {
        settled.exitCode = 0
        settled.emit('close', 0, null)
      }, 5)
      process.stdout.write(JSON.stringify([
        await waitChildClose(hanging, 20),
        await waitChildClose(settled, 20),
      ]))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { settled: false, exitCode: null, signalCode: null },
      { settled: true, exitCode: 0, signalCode: null },
    ])
  })
})
