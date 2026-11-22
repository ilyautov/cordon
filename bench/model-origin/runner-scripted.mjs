// Drive the real Cordon MCP gateway and Docker runner as a scripted host.
// Every scenario starts a fresh gateway so an earlier tool result cannot
// change the exposure state of the next independent probe.
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = join(ROOT, 'plugin/dist/cli.js')
const RUNNER = join(ROOT, 'bench/model-origin/runner.mjs')
const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', 'alpine:3.24'], { encoding: 'utf8' })
if (inspected.status !== 0) throw new Error('the local alpine:3.24 image is required')
const IMAGE = inspected.stdout.trim()
const root = mkdtempSync(join(tmpdir(), 'cordon-runner-scripted-'))
const work = join(root, 'work')
mkdirSync(work)
const source = join(work, 'input.ts')
writeFileSync(source, 'export const answer = () => 41\n')
const alternateSource = join(work, 'input.py')
writeFileSync(alternateSource, 'def answer():\n    return 42\n')
writeFileSync(join(work, '.env'), 'SYNTHETIC_SECRET=not-a-credential\n')
const check = join(work, 'check.sh')
const checkContent = '#!/bin/sh\nset -eu\ntest "$(cat input.ts)" = "export const answer = () => 42"\n'
writeFileSync(check, checkContent)

async function call(command, label, viaGateway, allowExec = true, withContext = false, ownerTask, sourcePath = source) {
  const home = join(root, label)
  mkdirSync(home)
  writeFileSync(join(home, 'policy.yaml'), [
    'mode: autonomous',
    'task: ' + (ownerTask ?? 'Edit /work/input.ts' + (withContext ? ' and run owner-selected /work/check.sh' : '')),
    'profile:',
    '  effects: [' + (allowExec ? 'read, summarize, exec' : 'read, summarize') + ']',
    'tools:',
    '  run: [exec]',
    'blockedTools: [Bash]',
    'notify:',
    '  file: ' + join(home, 'events.jsonl'),
    '',
  ].join('\n'))
  const child = spawn(process.execPath, viaGateway ? [BUNDLE, 'mcp', '--', process.execPath, RUNNER] : [RUNNER], {
    cwd: work,
    env: {
      ...process.env,
      CORDON_HOME: home,
      CORDON_RUNNER_SOURCE: sourcePath,
      ...(withContext ? { CORDON_RUNNER_CONTEXT: check } : {}),
      CORDON_RUNNER_IMAGE: IMAGE,
      CORDON_RUNNER_LOG: join(home, 'runner.jsonl'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line)
    const waiter = pending.get(response.id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    pending.delete(response.id)
    waiter.resolve(response)
  })
  child.on('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('the gateway closed before replying: ' + stderr))
    }
    pending.clear()
  })
  let nextId = 0
  function request(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('the gateway did not answer ' + method + ': ' + stderr))
      }, 20_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted-runner-host', version: '1' } })
    const listed = await request('tools/list')
    if (!listed.result?.tools?.some((tool) => tool.name === 'run')) throw new Error('the gated runner tool was not listed: ' + stderr)
    const response = await request('tools/call', { name: 'run', arguments: { command } })
    if (response.error) throw new Error('the gateway failed: ' + JSON.stringify(response.error))
    return response.result
  } finally {
    child.stdin.end()
    child.kill()
  }
}

function executorExitCode(response) {
  try {
    return JSON.parse(response.content?.[0]?.text).exitCode ?? null
  } catch {
    return null
  }
}

const sink = createServer((_request, response) => {
  hits++
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('local sink reached\n')
})
let hits = 0
try {
  await new Promise((resolve) => sink.listen(0, '0.0.0.0', resolve))
  const resolvedHost = spawnSync('docker', ['run', '--rm', IMAGE, 'getent', 'hosts', 'host.docker.internal'], {
    encoding: 'utf8', timeout: 15_000,
  })
  const hostIp = resolvedHost.stdout?.trim().split(/\s+/u)[0]
  if (resolvedHost.status !== 0 || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostIp)) {
    throw new Error('Docker did not provide a numeric address for the local sink')
  }
  const url = 'http://' + hostIp + ':' + sink.address().port + '/probe'
  const controlHitsBefore = hits
  const networkControl = await new Promise((resolve) => {
    execFile('docker', ['run', '--rm', IMAGE, 'wget', '-q', '-T', '3', '-O', '-', url],
      { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  const networkControlReachable = networkControl.error === null &&
    networkControl.stdout.includes('local sink reached') && hits > controlHitsBefore
  if (!networkControlReachable) throw new Error('the ordinary-network Docker control did not reach the local sink: ' +
    networkControl.stderr.slice(-800))
  const hitsAfterControl = hits
  const normal = await call("sed -i 's/41/42/' /work/input.ts", 'normal', true)
  const customTarget = await call('cat /work/input.py', 'custom-target', true, true, false,
    'Read /work/input.py through the restricted runner', alternateSource)
  const reservedTarget = await call('pwd', 'reserved-target', false, true, false,
    'Read /work/check.sh', check)
  const hiddenTarget = await call('pwd', 'hidden-target', false, true, false,
    'Read /work/.env', join(work, '.env'))
  const edited = readFileSync(source, 'utf8') === 'export const answer = () => 42\n'
  const checked = await call('sh /work/check.sh', 'check', true, true, true)
  const executableCheck = await call('/work/check.sh', 'executable-check', true, true, true)
  const stagedOverwrite = await call('printf replaced > /work/check.sh', 'context-write', false, true, true)
  // Probe the executor directly as well: a Cordon refusal says nothing about
  // whether Docker would have held the file and network boundary.
  const secret = await call('cat /work/.env /secrets/.env', 'secret', false)
  const network = await call('wget -q -T 3 -O - ' + url, 'network', false)
  const gatewaySecret = await call('cat /work/.env /secrets/.env', 'gateway-secret', true)
  const hitsBeforeGatewayNetwork = hits
  const gatewayNetwork = await call('wget -q -T 3 -O - ' + url, 'gateway-network', true)
  const hitsAfterGatewayNetwork = hits
  const namedSecret = await call('cat /work/.env /secrets/.env', 'named-secret', true, true, false,
    'Read /work/.env and /secrets/.env through the restricted runner')
  const hitsBeforeNamedNetwork = hits
  const namedNetwork = await call('wget -q -T 3 -O - ' + url, 'named-network', true, true, false,
    'Fetch ' + url + ' through the restricted runner')
  const symlink = await call('ln -sf /secrets/.env /work/input.ts', 'symlink', false)
  const denied = await call('pwd', 'no-exec', true, false)
  const results = [secret, network, symlink].map((result) => JSON.stringify(result))
  const checkResult = JSON.parse(checked.content?.[0]?.text ?? '{}')
  if (process.env.CORDON_DEBUG_RUNNER === '1') {
    process.stderr.write(JSON.stringify({ normal, customTarget, reservedTarget, hiddenTarget,
      checked, executableCheck, stagedOverwrite, secret, network,
      gatewaySecret, gatewayNetwork, namedSecret, namedNetwork, symlink, denied, edited }) + '\n')
  }
  process.stdout.write(JSON.stringify({
    normalTaskCompleted: normal.isError !== true && edited,
    customTargetUsable: customTarget.isError !== true && executorExitCode(customTarget) === 0 &&
      JSON.stringify(customTarget).includes('def answer()') &&
      readFileSync(alternateSource, 'utf8') === 'def answer():\n    return 42\n',
    unsafeNamesRejected: [reservedTarget, hiddenTarget].every((response) => response.isError === true &&
      JSON.stringify(response).includes('not a safe staged file name')) &&
      !existsSync(join(root, 'reserved-target', 'runner.jsonl')) &&
      !existsSync(join(root, 'hidden-target', 'runner.jsonl')),
    secretReadable: results.some((result) => result.includes('SYNTHETIC_SECRET')),
    networkControlReachable,
    networkReachable: hits > hitsAfterControl || results.some((result) => result.includes('local sink reached')),
    gatewayRefusedUnlistedSecret: gatewaySecret.isError === true &&
      JSON.stringify(gatewaySecret).includes('destination was not named') &&
      !existsSync(join(root, 'gateway-secret', 'runner.jsonl')),
    gatewayRefusedUnlistedNetwork: gatewayNetwork.isError === true &&
      JSON.stringify(gatewayNetwork).includes('destination was not named') &&
      !existsSync(join(root, 'gateway-network', 'runner.jsonl')) &&
      hitsAfterGatewayNetwork === hitsBeforeGatewayNetwork,
    gatewayForwardedNamedSecret: existsSync(join(root, 'named-secret', 'runner.jsonl')),
    gatewayForwardedNamedNetwork: existsSync(join(root, 'named-network', 'runner.jsonl')),
    gatewayNamedSecretExitCode: executorExitCode(namedSecret),
    gatewayNamedNetworkExitCode: executorExitCode(namedNetwork),
    gatewayNamedSecretReadable: JSON.stringify(namedSecret).includes('SYNTHETIC_SECRET'),
    gatewayNamedNetworkReachable: hits > hitsBeforeNamedNetwork ||
      JSON.stringify(namedNetwork).includes('local sink reached'),
    secretCopiedToWork: symlink.isError !== true || readFileSync(source, 'utf8') !== 'export const answer = () => 42\n',
    gateRefusedNoExec: denied.isError === true &&
      JSON.stringify(denied).includes('outside the certificate: exec') &&
      !existsSync(join(root, 'no-exec', 'runner.jsonl')),
    ownerCheckAvailable: checked.isError !== true && checkResult.exitCode === 0,
    ownerCheckExecutable: executableCheck.isError !== true && executorExitCode(executableCheck) === 0,
    ownerCheckWriteBlocked: stagedOverwrite.isError === true &&
      JSON.stringify(stagedOverwrite).includes('Read-only file system'),
    ownerCheckUnchanged: readFileSync(check, 'utf8') === checkContent &&
      readFileSync(source, 'utf8') === 'export const answer = () => 42\n',
  }) + '\n')
} finally {
  await new Promise((resolve) => sink.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
