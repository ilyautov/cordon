import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'

it('admits only one runner process for an owner-selected source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cordon-runner-concurrent-'))
  const source = join(root, 'input.ts')
  const docker = join(root, 'docker')
  const ready = join(root, 'first-ready')
  const release = join(root, 'release-first')
  const request = (command: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'run', arguments: { command } } }) + '\n'
  const env = { ...process.env, PATH: root + delimiter + process.env.PATH,
    FAKE_READY: ready, FAKE_RELEASE: release,
    CORDON_RUNNER_SOURCE: source, CORDON_RUNNER_IMAGE: 'sha256:' + 'a'.repeat(64), CORDON_RUNNER_VERIFY: '0' }
  let first: ChildProcess | undefined
  try {
    writeFileSync(source, 'export const answer = () => 41\n')
    writeFileSync(docker, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const mount = args[args.indexOf('--mount') + 1]
const stage = mount.match(/src=([^,]+)/)[1]
const command = args.at(-1)
if (command === 'first') {
  writeFileSync(process.env.FAKE_READY, '')
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(process.env.FAKE_RELEASE)) Atomics.wait(pause, 0, 0, 20)
}
writeFileSync(join(stage, 'input.ts'), 'export const answer = () => ' + (command === 'first' ? '42' : '99') + '\\n')
`, { mode: 0o755 })

    first = spawn(process.execPath, [join(process.cwd(), 'bench/model-origin/runner.mjs')], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let firstOutput = ''
    first.stdout!.setEncoding('utf8').on('data', (part: string) => { firstOutput += part })
    first.stdin!.end(request('first'))
    const deadline = Date.now() + 3000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(existsSync(ready)).toBe(true)

    const second = spawnSync(process.execPath, [join(process.cwd(), 'bench/model-origin/runner.mjs')], {
      env, input: request('second'), encoding: 'utf8', timeout: 5000,
    })
    if (second.error) throw second.error
    expect(second.status).toBe(0)
    const refused = JSON.parse(second.stdout.trim()).result
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('already running for this source')

    writeFileSync(release, '')
    await new Promise<void>((resolve, reject) => {
      first!.once('close', (code) => code === 0 ? resolve() : reject(new Error('first runner exited ' + code)))
    })
    expect(JSON.parse(firstOutput.trim()).result.isError).not.toBe(true)
    expect(readFileSync(source, 'utf8')).toBe('export const answer = () => 42\n')
    expect(existsSync(source + '.cordon-lock')).toBe(false)

    writeFileSync(source + '.cordon-lock', 'stale')
    const stale = spawnSync(process.execPath, [join(process.cwd(), 'bench/model-origin/runner.mjs')], {
      env, input: request('second'), encoding: 'utf8', timeout: 5000,
    })
    if (stale.error) throw stale.error
    expect(JSON.parse(stale.stdout.trim()).result.content[0].text).toContain('inspect the lock before retrying')
    expect(readFileSync(source, 'utf8')).toBe('export const answer = () => 42\n')
  } finally {
    writeFileSync(release, '')
    first?.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
