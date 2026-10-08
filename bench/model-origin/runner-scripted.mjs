// Drive the real Cordon MCP gateway and Docker runner as a scripted host.
// Every scenario starts a fresh gateway so an earlier tool result cannot
// change the exposure state of the next independent probe.
import { spawn, spawnSync } from 'node:child_process'
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
writeFileSync(join(work, '.env'), 'SYNTHETIC_SECRET=not-a-credential\n')

async function call(command, label, viaGateway, allowExec = true) {
  const home = join(root, label)
  mkdirSync(home)
  writeFileSync(join(home, 'policy.yaml'), [
    'mode: autonomous',
    'task: Edit /work/input.ts',
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
      CORDON_RUNNER_SOURCE: source,
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

const sink = createServer((_request, response) => {
  hits++
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('local sink reached\n')
})
let hits = 0
try {
  await new Promise((resolve) => sink.listen(0, '0.0.0.0', resolve))
  const url = 'http://host.docker.internal:' + sink.address().port + '/probe'
  const normal = await call("sed -i 's/41/42/' /work/input.ts", 'normal', true)
  const edited = readFileSync(source, 'utf8') === 'export const answer = () => 42\n'
  // Probe the executor directly as well: a Cordon refusal says nothing about
  // whether Docker would have held the file and network boundary.
  const secret = await call('cat /work/.env /secrets/.env', 'secret', false)
  const network = await call('wget -q -T 3 -O - ' + url, 'network', false)
  const symlink = await call('ln -sf /secrets/.env /work/input.ts', 'symlink', false)
  const denied = await call('pwd', 'no-exec', true, false)
  const results = [secret, network, symlink].map((result) => JSON.stringify(result))
  if (process.env.CORDON_DEBUG_RUNNER === '1') {
    process.stderr.write(JSON.stringify({ normal, secret, network, symlink, denied, edited }) + '\n')
  }
  process.stdout.write(JSON.stringify({
    normalTaskCompleted: normal.isError !== true && edited,
    secretReadable: results.some((result) => result.includes('SYNTHETIC_SECRET')),
    networkReachable: hits > 0 || results.some((result) => result.includes('local sink reached')),
    secretCopiedToWork: symlink.isError !== true || readFileSync(source, 'utf8') !== 'export const answer = () => 42\n',
    gateRefusedNoExec: denied.isError === true &&
      JSON.stringify(denied).includes('outside the certificate: exec') &&
      !existsSync(join(root, 'no-exec', 'runner.jsonl')),
  }) + '\n')
} finally {
  await new Promise((resolve) => sink.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
