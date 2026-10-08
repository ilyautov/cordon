import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ensureBuiltCli } from '../../support/built-cli.js'

const CLI = join(process.cwd(), 'dist', 'cli.js')
const FAKE_SERVER = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))
const currentUid = (): number => {
  if (typeof process.getuid !== 'function') throw new Error('Unix sockets require a POSIX user identity')
  return process.getuid()
}

function waitForClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  if (child.signalCode !== null) return Promise.resolve(null)
  return new Promise((resolve) => child.once('close', resolve))
}

async function waitForSocket(path: string, server: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return
    if (server.exitCode !== null) throw new Error(`owner service exited with ${server.exitCode}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('owner service did not create its socket')
}

describe.skipIf(typeof process.getuid !== 'function')('owner-controlled MCP socket transport', () => {
  it('refuses a socket directory another user could replace', () => {
    ensureBuiltCli()
    const root = mkdtempSync(join(tmpdir(), 'cordon-mcp-unsafe-socket-'))
    const home = join(root, 'home')
    const socketDir = join(root, 'socket')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(socketDir, { mode: 0o700 })
    chmodSync(socketDir, 0o777)
    writeFileSync(join(home, 'policy.yaml'), 'mode: autonomous\n')
    const socket = join(socketDir, 'gateway.sock')
    const result = spawnSync(process.execPath,
      [CLI, 'mcp', 'serve', '--socket', socket, '--', process.execPath, FAKE_SERVER], {
        env: { ...process.env, CORDON_HOME: home }, encoding: 'utf8', timeout: 2000,
      })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('socket directory must belong to this user')
    expect(existsSync(socket)).toBe(false)
  })

  it('gates an agent bridge call while keeping policy and upstream in the owner service', async () => {
    ensureBuiltCli()
    const root = mkdtempSync(join(tmpdir(), 'cordon-mcp-socket-'))
    const home = join(root, 'owner-home')
    const socketDir = join(root, 'socket')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(socketDir, { mode: 0o700 })
    const socket = join(socketDir, 'gateway.sock')
    const calls = join(root, 'calls.log')
    writeFileSync(join(home, 'policy.yaml'), [
      'mode: autonomous',
      'profile:',
      '  effects: [read]',
      'tools:',
      '  poisoned_page: [read]',
      '  update_price: [update]',
      'toolsReturn:',
      '  poisoned_page: rendered',
      '',
    ].join('\n'))

    const owner = spawn(process.execPath, [CLI, 'mcp', 'serve', '--socket', socket, '--', process.execPath, FAKE_SERVER], {
      env: { ...process.env, CORDON_HOME: home, FAKE_CALL_LOG: calls },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let ownerError = ''
    owner.stderr!.setEncoding('utf8').on('data', (part: string) => { ownerError += part })
    let bridge: ChildProcess | null = null
    try {
      await waitForSocket(socket, owner)
      expect(statSync(socket).mode & 0o777).toBe(0o600)
      const wrongOwner = spawnSync(process.execPath,
        [CLI, 'mcp', 'connect', '--socket', socket, '--owner-uid', String(currentUid() + 1)],
        { encoding: 'utf8' })
      expect(wrongOwner.status).toBe(1)
      expect(wrongOwner.stderr).toContain('expected owner')
      bridge = spawn(process.execPath, [CLI, 'mcp', 'connect', '--socket', socket, '--owner-uid', String(currentUid())], {
        env: { ...process.env, CORDON_HOME: join(root, 'agent-has-no-policy') },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let bridgeError = ''
      bridge.stderr!.setEncoding('utf8').on('data', (part: string) => { bridgeError += part })
      const queue: Array<Record<string, unknown>> = []
      const waiters: Array<() => void> = []
      createInterface({ input: bridge.stdout! }).on('line', (line) => {
        queue.push(JSON.parse(line) as Record<string, unknown>)
        for (const wake of waiters.splice(0)) wake()
      })
      const next = async (): Promise<Record<string, unknown>> => {
        while (queue.length === 0) {
          await Promise.race([
            new Promise<void>((wake) => waiters.push(wake)),
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(
              `no MCP reply: owner=${ownerError}; bridge=${bridgeError}; ownerExit=${owner.exitCode}; bridgeExit=${bridge?.exitCode}`,
            )), 2000)),
          ])
        }
        return queue.shift()!
      }
      bridge.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
      expect((await next()).id).toBe(1)
      bridge.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'update_price', arguments: { nmId: '99887766', price: 1 } } }) + '\n')
      const denied = (await next()).result as { isError?: boolean }
      expect(denied.isError).toBe(true)
      expect(existsSync(calls)).toBe(false)
      bridge.stdin!.end()
      expect(await waitForClose(bridge)).toBe(0)
    } finally {
      bridge?.kill()
      owner.kill('SIGTERM')
      await waitForClose(owner)
    }
    expect(ownerError).not.toContain('error')
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('')
  }, 15_000)

  it('stops the bridge and listener when the upstream sends invalid protocol data', async () => {
    ensureBuiltCli()
    const root = mkdtempSync(join(tmpdir(), 'cmcp-bad-'))
    const home = join(root, 'home')
    const socketDir = join(root, 'socket')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(socketDir, { mode: 0o700 })
    writeFileSync(join(home, 'policy.yaml'), 'mode: autonomous\n')
    const socket = join(socketDir, 'gateway.sock')
    const owner = spawn(process.execPath,
      [CLI, 'mcp', 'serve', '--socket', socket, '--', process.execPath, FAKE_SERVER], {
        env: { ...process.env, CORDON_HOME: home, FAKE_BAD_JSON: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    let ownerError = ''
    owner.stderr!.setEncoding('utf8').on('data', (part: string) => { ownerError += part })
    let bridge: ChildProcess | null = null
    try {
      await waitForSocket(socket, owner).catch((error: Error) => { throw new Error(`${error.message}: ${ownerError}`) })
      bridge = spawn(process.execPath,
        [CLI, 'mcp', 'connect', '--socket', socket, '--owner-uid', String(currentUid())], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      bridge.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n')
      expect(await waitForClose(bridge)).toBe(1)
      expect(await waitForClose(owner)).toBe(1)
      expect(ownerError).toContain('not JSON-RPC')
      expect(existsSync(socket)).toBe(false)
    } finally {
      bridge?.kill()
      owner.kill('SIGTERM')
      await waitForClose(owner)
    }
  }, 15_000)
})
