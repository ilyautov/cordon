// Benchmark-only MCP executor. The owner fixes one writable source, an
// optional check script, and an image; the model chooses only the command.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

const SOURCE = process.env.CORDON_RUNNER_SOURCE
const CONTEXT = process.env.CORDON_RUNNER_CONTEXT
const IMAGE = process.env.CORDON_RUNNER_IMAGE
const LOG = process.env.CORDON_RUNNER_LOG
const VERIFY = process.env.CORDON_RUNNER_VERIFY
const MAX_FILE = 256 * 1024
const MAX_COMMAND = 4096

const TOOL = {
  name: 'run',
  description: 'Run one command in a network-isolated Docker container against owner-selected files.',
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
  const target = basename(SOURCE)
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(target) || target === 'check.sh') {
    throw new Error('the owner-selected source name is not a safe staged file name')
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(IMAGE ?? '')) {
    throw new Error('CORDON_RUNNER_IMAGE must be an owner-selected local image ID, not a mutable tag')
  }
  const stat = lstatSync(SOURCE)
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('the owner-selected source is not a regular file within the size limit')
  return stat
}

function configuredContext(source) {
  if (CONTEXT === undefined) return null
  if (!isAbsolute(CONTEXT)) throw new Error('CORDON_RUNNER_CONTEXT must be an absolute file path')
  const stat = lstatSync(CONTEXT)
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('the owner-selected check is not a regular file within the size limit')
  if (stat.dev === source.dev && stat.ino === source.ino) throw new Error('the check and source must be different files')
  return stat
}

function stagedContent(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('the staged source is no longer a regular file within the size limit')
  // A command can replace the staged source with a symlink. Opening it as the host
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

function runIsolated(stage, command, contextPath = null, readonlyWork = false) {
  const container = 'cordon-runner-' + randomUUID()
  // The verifier must execute the owner check even if the pinned image has
  // an entrypoint; the model's command keeps the earlier benchmark shape.
  const args = [
    'run', '--rm', '--name', container, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '128m', '--cpus', '1',
    '--user', String(process.getuid()) + ':' + String(process.getgid()),
    '--mount', 'type=bind,src=' + stage + ',dst=/work' + (readonlyWork ? ',readonly' : ''),
    '--workdir', '/work',
    ...(contextPath === null ? [] : ['--mount', 'type=bind,src=' + contextPath + ',dst=/work/check.sh,readonly']),
    ...(readonlyWork ? ['--entrypoint', 'sh'] : []),
    IMAGE, ...(readonlyWork ? [] : ['sh']), '-c', command,
  ]
  // A loaded Docker Desktop took 50 seconds just to start the image in the
  // separate-UID trial; a shorter limit counted startup as model failure.
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 })
  if (result.error) {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore', timeout: 5_000 })
    throw new Error('isolated executor failed: ' + result.error.message)
  }
  return result
}

function verifyCandidate(updated, contextContent) {
  const stage = mkdtempSync(join(tmpdir(), 'cordon-runner-verify-'))
  try {
    writeFileSync(join(stage, basename(SOURCE)), updated)
    writeFileSync(join(stage, 'check.sh'), contextContent, { mode: 0o555 })
    // A fresh read-only mount excludes files the model left beside the source.
    return runIsolated(stage, 'sh /work/check.sh', null, true).status
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function execute(command) {
  const original = configuredSource()
  // Separate gateway processes can receive calls for the same owner file.
  // The content check below is not atomic with rename, so only one cooperating
  // runner may reach it at a time. A crash leaves the lock in place for owner
  // inspection rather than guessing whether a still-running call is stale.
  const lockPath = SOURCE + '.cordon-lock'
  let lock
  try {
    lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('a runner call is already running for this source; inspect the lock before retrying')
    throw error
  }
  try {
    return executeLocked(command, original)
  } finally {
    closeSync(lock)
    rmSync(lockPath, { force: true })
  }
}

function executeLocked(command, original) {
  configuredContext(original)
  if (VERIFY !== undefined && VERIFY !== '0' && VERIFY !== '1') {
    throw new Error('CORDON_RUNNER_VERIFY must be 0 or 1')
  }
  if (VERIFY === '1' && CONTEXT === undefined) {
    throw new Error('CORDON_RUNNER_VERIFY requires an owner-selected check')
  }
  if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_COMMAND || command.includes('\0')) {
    throw new Error('command must be a nonempty string of at most 4096 characters')
  }
  const stage = mkdtempSync(join(tmpdir(), 'cordon-runner-'))
  const staged = join(stage, basename(SOURCE))
  try {
    const originalContent = stagedContent(SOURCE)
    const contextContent = CONTEXT === undefined ? null : stagedContent(CONTEXT)
    writeFileSync(staged, originalContent)
    // The model may run the owner-selected check, but its own command cannot
    // substitute for the independent verification before copyback.
    if (contextContent !== null) writeFileSync(join(stage, 'check.sh'), contextContent, { mode: 0o555 })
    const result = runIsolated(stage, command, contextContent === null ? null : join(stage, 'check.sh'))
    const output = {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      changed: false,
      ...(VERIFY === '1' ? { verified: false, verificationExitCode: null } : {}),
    }
    if (result.status === 0) {
      const updated = stagedContent(staged)
      if (VERIFY === '1') {
        output.verificationExitCode = verifyCandidate(updated, contextContent)
        output.verified = output.verificationExitCode === 0
      }
      if (VERIFY !== '1' || output.verified) {
        output.changed = !updated.equals(originalContent)
      }
      if (output.changed) {
        const current = lstatSync(SOURCE)
        if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino ||
          !stagedContent(SOURCE).equals(originalContent)) {
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
    if (LOG) writeFileSync(LOG, JSON.stringify({ command, exitCode: output.exitCode, changed: output.changed,
      ...(VERIFY === '1' ? { verified: output.verified, verificationExitCode: output.verificationExitCode } : {}) }) + '\n', { flag: 'a' })
    const succeeded = result.status === 0 && (VERIFY !== '1' || output.verified)
    return { content: [{ type: 'text', text: JSON.stringify(output) }], ...(succeeded ? {} : { isError: true }) }
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
