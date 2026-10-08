import { chmodSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Policy } from '../../policy/defaults.js'
import { runGateway } from './gateway.js'

export interface SocketGatewayOptions {
  path: string
  command: string[]
  policy: Policy
  cordonHome: string
  policyFile: string
  approvalWaitMs: number
  log?: (line: string) => void
}

function socketPath(path: string): string {
  if (!isAbsolute(path)) throw new Error('the MCP socket path must be absolute')
  const parent = realpathSync(dirname(path))
  const stat = lstatSync(parent)
  if (!stat.isDirectory() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0) {
    throw new Error('the MCP socket directory must belong to this user and deny group and other writes')
  }
  return join(parent, basename(path))
}

function existing(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** The policy and upstream stay in this owner's process; each client gets a fresh gateway session. */
export function serveSocketGateway(options: SocketGatewayOptions): Promise<number> {
  const path = socketPath(options.path)
  if (existing(path)) throw new Error('the MCP socket path already exists; remove a stale socket by hand')
  const log = options.log ?? ((line: string) => process.stderr.write(`cordon mcp serve: ${line}\n`))

  return new Promise((resolve) => {
    let stopped = false
    let listening = false
    let inode: { dev: number; ino: number } | null = null
    let active: Socket | null = null
    let oldUmask: number | null = process.umask(0o177)
    const restoreUmask = (): void => {
      if (oldUmask !== null) process.umask(oldUmask)
      oldUmask = null
    }
    const cleanup = (): void => {
      if (inode === null) return
      try {
        const now = lstatSync(path)
        if (now.dev === inode.dev && now.ino === inode.ino) unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`could not remove socket: ${(error as Error).message}`)
      }
    }
    const stop = (code: number, reason?: string): void => {
      if (stopped) return
      stopped = true
      restoreUmask()
      if (reason !== undefined) log(reason)
      active?.destroy()
      if (listening) server.close(() => { cleanup(); resolve(code) })
      else { cleanup(); resolve(code) }
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
    }
    const onInterrupt = (): void => stop(0)
    const onTerminate = (): void => stop(0)
    const server = createServer((socket) => {
      if (stopped || active !== null) {
        socket.destroy()
        return
      }
      active = socket
      socket.on('error', (error) => log(`client socket failed: ${error.message}`))
      void runGateway({
        command: options.command,
        policy: options.policy,
        cordonHome: options.cordonHome,
        policyFile: options.policyFile,
        approvalWaitMs: options.approvalWaitMs,
        hostIn: socket,
        hostOut: socket,
        log,
      }).then((code) => {
        socket.destroy()
        active = null
        if (code !== 0) stop(code, 'a gateway session failed; the owner service stops')
      }).catch((error) => stop(1, `the gateway session failed: ${(error as Error).message}`))
    })
    server.on('error', (error) => stop(1, `socket listener failed: ${error.message}`))
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    try {
      server.listen(path, () => {
        listening = true
        restoreUmask()
        try {
          chmodSync(path, 0o600)
          const stat = lstatSync(path)
          inode = { dev: stat.dev, ino: stat.ino }
        } catch (error) {
          stop(1, `could not secure the MCP socket: ${(error as Error).message}`)
        }
      })
    } catch (error) {
      stop(1, `could not start the MCP socket: ${(error as Error).message}`)
    }
  })
}

/** A byte bridge only. The agent side has no policy, upstream command or Docker access through this process. */
export function connectSocketGateway(
  path: string,
  ownerUid: number,
  hostIn: Readable = process.stdin,
  hostOut: Writable = process.stdout,
  log: (line: string) => void = (line) => process.stderr.write(`cordon mcp connect: ${line}\n`),
): Promise<number> {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('the expected owner UID must be a nonnegative integer')
  const resolved = socketPathForClient(path, ownerUid)
  return new Promise((resolve) => {
    const socket = createConnection(resolved)
    let settled = false
    let hostEnded = false
    let connected = false
    const finish = (code: number, reason?: string): void => {
      if (settled) return
      settled = true
      if (reason !== undefined) log(reason)
      hostIn.unpipe(socket)
      socket.unpipe(hostOut)
      socket.destroy()
      resolve(code)
    }
    hostIn.once('end', () => {
      hostEnded = true
      if (connected) socket.end()
    })
    socket.on('connect', () => {
      connected = true
      socket.pipe(hostOut, { end: false })
      if (hostEnded) socket.end()
      else hostIn.pipe(socket)
    })
    socket.on('error', (error) => finish(1, `owner socket failed: ${error.message}`))
    socket.on('close', () => finish(hostEnded ? 0 : 1, hostEnded ? undefined : 'owner socket closed before the host did'))
    hostOut.on('error', (error) => finish(1, `host output failed: ${error.message}`))
  })
}

function socketPathForClient(path: string, ownerUid: number): string {
  if (!isAbsolute(path)) throw new Error('the MCP socket path must be absolute')
  const parent = realpathSync(dirname(path))
  const directory = lstatSync(parent)
  const resolved = join(parent, basename(path))
  const socket = lstatSync(resolved)
  if (directory.uid !== ownerUid || (directory.mode & 0o022) !== 0 ||
    !socket.isSocket() || socket.uid !== ownerUid || (socket.mode & 0o007) !== 0) {
    throw new Error('the MCP socket or its directory is not owned and protected by the expected owner')
  }
  return resolved
}
