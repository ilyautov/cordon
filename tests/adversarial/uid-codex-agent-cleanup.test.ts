import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('distinct-UID agent container cleanup', () => {
  it('removes only the named benchmark agent before network cleanup', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { removeNamedAgent } from './bench/model-origin/uid-codex-agent-cleanup.mjs'
      const calls = []
      const run = (args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } }
      const removed = removeNamedAgent(run, 'cordon-model-012345abcdef-agent')
      process.stdout.write(JSON.stringify({ removed, calls }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({
      removed: true,
      calls: [
        ['container', 'inspect', '--format', '{{.Id}}', 'cordon-model-012345abcdef-agent'],
        ['rm', '-f', 'cordon-model-012345abcdef-agent'],
      ],
    })
  })

  it('rejects a name outside the disposable benchmark namespace', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { removeNamedAgent } from './bench/model-origin/uid-codex-agent-cleanup.mjs'
      try { removeNamedAgent(() => { throw new Error('must not inspect') }, 'my-container') }
      catch (error) { process.stdout.write(error.message) }
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(output).toBe('invalid benchmark agent container name')
  })

  it('accepts a container already removed by Docker auto-remove', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { removeNamedAgent } from './bench/model-origin/uid-codex-agent-cleanup.mjs'
      const calls = []
      const run = (args) => { calls.push(args); return { status: 1, stdout: '',
        stderr: 'Error: No such object: cordon-model-012345abcdef-agent' } }
      process.stdout.write(JSON.stringify({ removed: removeNamedAgent(run,
        'cordon-model-012345abcdef-agent'), calls }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({ removed: false, calls: [
      ['container', 'inspect', '--format', '{{.Id}}', 'cordon-model-012345abcdef-agent'],
    ] })
  })
})
