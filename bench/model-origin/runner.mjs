// Benchmark-only MCP executor. The owner fixes one source file and one image;
// a model chooses only the command run against a staged copy inside Docker.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

const SOURCE = process.env.CORDON_RUNNER_SOURCE
const IMAGE = process.env.CORDON_RUNNER_IMAGE
const LOG = process.env.CORDON_RUNNER_LOG
const MAX_FILE = 256 * 1024
const MAX_COMMAND = 4096

const TOOL = {
  name: 'run',
  description: 'Run one command in a network-isolated Docker container against one owner-selected file.',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: 'Shell command to execute inside the restricted container.' } },
    required: ['command'],
    additionalProperties: false,
  },
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

function configuredSource() {
  if (!SOURCE || !isAbsolute(SOURCE)) throw new Error('CORDON_RUNNER_SOURCE must be an absolute file path')
  if (!/^sha256:[a-f0-9]{64}$/u.test(IMAGE ?? '')) {
    throw new Error('CORDON_RUNNER_IMAGE must be an owner-selected local image ID, not a mutable tag')
  }
  const stat = lstatSync(SOURCE)
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('the owner-selected source is not a regular file within the size limit')
  return stat
}

function stagedContent(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('the staged source is no longer a regular file within the size limit')
  // A command can replace input.ts with a symlink. Opening it as the host
  // would follow that link outside Docker, so nofollow is load-bearing here.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > MAX_FILE) throw new Error('the staged source changed while opening')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function execute(command) {
  const original = configuredSource()
  if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_COMMAND || command.includes('\0')) {
    throw new Error('command must be a nonempty string of at most 4096 characters')
  }
  const stage = mkdtempSync(join(tmpdir(), 'cordon-runner-'))
  const staged = join(stage, 'input.ts')
  const container = 'cordon-runner-' + randomUUID()
  try {
    const originalContent = stagedContent(SOURCE)
    writeFileSync(staged, originalContent)
    const args = [
      'run', '--rm', '--name', container, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--memory', '128m', '--cpus', '1',
      '--user', String(process.getuid()) + ':' + String(process.getgid()),
      '--mount', 'type=bind,src=' + stage + ',dst=/work', '--workdir', '/work',
      IMAGE, 'sh', '-c', command,
    ]
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 })
    if (result.error) {
      spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 5_000 })
      throw new Error('isolated executor failed: ' + result.error.message)
    }
    const output = {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      changed: false,
    }
    if (result.status === 0) {
      const updated = stagedContent(staged)
      output.changed = !updated.equals(originalContent)
      if (output.changed) {
        const current = lstatSync(SOURCE)
        if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
          throw new Error('the owner-selected source changed during execution')
        }
        const replacement = join(dirname(SOURCE), '.' + basename(SOURCE) + '.cordon-' + randomUUID())
        try {
          writeFileSync(replacement, updated, { mode: current.mode })
          renameSync(replacement, SOURCE)
        } finally {
          rmSync(replacement, { force: true })
        }
      }
    }
    if (LOG) writeFileSync(LOG, JSON.stringify({ command, exitCode: output.exitCode, changed: output.changed }) + '\n', { flag: 'a' })
    return { content: [{ type: 'text', text: JSON.stringify(output) }], ...(result.status === 0 ? {} : { isError: true }) }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    // A broken JSON-RPC request has no reliable id; emitting nothing is the
    // protocol response, while the process stays alive for valid requests.
    return
  }
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cordon-isolated-runner-benchmark', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'tools/list') return reply(message.id, { tools: [TOOL] })
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'run') return reply(message.id, fail('unknown tool'))
    try {
      return reply(message.id, execute(message.params?.arguments?.command))
    } catch (error) {
      return reply(message.id, fail('isolated executor refused: ' + error.message))
    }
  }
  reply(message.id, {})
})
