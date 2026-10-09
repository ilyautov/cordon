import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'

it('checks model edits in a fresh stage before copying them to the owner file', () => {
  const root = mkdtempSync(join(tmpdir(), 'cordon-runner-verification-'))
  const source = join(root, 'input.ts')
  const check = join(root, 'check.sh')
  const log = join(root, 'docker.jsonl')
  const fakeDocker = join(root, 'docker')
  const original = 'export const answer = () => 41\n'
  try {
    writeFileSync(source, original)
    writeFileSync(check, '#!/bin/sh\nset -eu\ntest "$(cat /work/input.ts)" = "export const answer = () => 42"\n')
    writeFileSync(fakeDocker, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] !== 'run') process.exit(2)
const mounts = args.flatMap((arg, index) => arg === '--mount' ? [args[index + 1]] : [])
const work = mounts.find((mount) => mount.includes('dst=/work') && !mount.includes('dst=/work/check.sh'))
const stage = work?.match(/src=([^,]+)/)?.[1]
if (!stage) process.exit(2)
const command = args.at(-1)
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ command, stage, work, entrypoint: args.includes('--entrypoint') }) + '\\n')
if (command === 'sh /work/check.sh') {
  if (existsSync(join(stage, 'bypass.txt'))) process.exit(0)
  process.exit(readFileSync(join(stage, 'input.ts'), 'utf8') === 'export const answer = () => 42\\n' ? 0 : 1)
}
if (command.includes('99')) {
  writeFileSync(join(stage, 'input.ts'), 'export const answer = () => 99\\n')
  writeFileSync(join(stage, 'bypass.txt'), '')
} else if (command.includes('race')) {
  writeFileSync(join(stage, 'input.ts'), 'export const answer = () => 42\\n')
  writeFileSync(process.env.FAKE_OWNER_SOURCE, 'export const answer = () => 43\\n')
} else if (command.includes('42')) {
  writeFileSync(join(stage, 'input.ts'), 'export const answer = () => 42\\n')
} else process.exit(2)
`, { mode: 0o755 })

    const call = (command: string, withContext = true, verify = true) => {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run', arguments: { command } } }
      const env = { ...process.env, PATH: root + delimiter + process.env.PATH,
        FAKE_DOCKER_LOG: log, FAKE_OWNER_SOURCE: source,
        CORDON_RUNNER_SOURCE: source, CORDON_RUNNER_CONTEXT: check,
        CORDON_RUNNER_IMAGE: 'sha256:' + 'a'.repeat(64), CORDON_RUNNER_VERIFY: verify ? '1' : '0' }
      if (!withContext) delete (env as { CORDON_RUNNER_CONTEXT?: string }).CORDON_RUNNER_CONTEXT
      const child = spawnSync(process.execPath, [join(process.cwd(), 'bench/model-origin/runner.mjs')], {
        input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 10_000, env,
      })
      if (child.error) throw child.error
      expect(child.status).toBe(0)
      return JSON.parse(child.stdout.trim()).result
    }

    const refused = call('write 99 and bypass the check')
    expect(refused.isError).toBe(true)
    expect(JSON.parse(refused.content[0].text)).toMatchObject({ changed: false, verified: false })
    expect(readFileSync(source, 'utf8')).toBe(original)

    const raced = call('write 42 during owner race')
    expect(raced.isError).toBe(true)
    expect(raced.content[0].text).toContain('the owner-selected source changed during execution')
    expect(readFileSync(source, 'utf8')).toBe('export const answer = () => 43\n')
    writeFileSync(source, original)

    const accepted = call('write 42')
    expect(accepted.isError).not.toBe(true)
    expect(JSON.parse(accepted.content[0].text)).toMatchObject({ changed: true, verified: true })
    expect(readFileSync(source, 'utf8')).toBe('export const answer = () => 42\n')

    const missingCheck = call('write 42', false)
    expect(missingCheck.isError).toBe(true)
    expect(missingCheck.content[0].text).toContain('CORDON_RUNNER_VERIFY requires an owner-selected check')

    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(calls.map((call) => call.command)).toEqual([
      'write 99 and bypass the check', 'sh /work/check.sh',
      'write 42 during owner race', 'sh /work/check.sh',
      'write 42', 'sh /work/check.sh',
    ])
    expect(calls[1].stage).not.toBe(calls[0].stage)
    expect(calls[3].stage).not.toBe(calls[2].stage)
    expect(calls[5].stage).not.toBe(calls[4].stage)
    expect(calls[1].work).toContain('readonly')
    expect(calls[3].work).toContain('readonly')
    expect(calls[5].work).toContain('readonly')
    expect(calls[1].entrypoint).toBe(true)
    expect(calls[3].entrypoint).toBe(true)
    expect(calls[5].entrypoint).toBe(true)

    writeFileSync(source, original)
    const legacy = call('write 42', true, false)
    expect(legacy.isError).not.toBe(true)
    expect(JSON.parse(legacy.content[0].text)).toMatchObject({ changed: true })
    expect(JSON.parse(legacy.content[0].text)).not.toHaveProperty('verified')
    expect(readFileSync(source, 'utf8')).toBe('export const answer = () => 42\n')
    const afterLegacy = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(afterLegacy.slice(calls.length).map((entry) => entry.command)).toEqual(['write 42'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
