// A new gateway process must not inherit an approval from the old session.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '../../plugin/dist/cli.js')
const SERVER = join(HERE, 'server.mjs')
const OWNER = 'ops@acme.example'
const ARGS = {
  to: OWNER,
  body: 'Northwind Traders March invoices INV-2291 to INV-2297 are missing after the April 2 migration.',
}

function approvalId(reply) {
  return /cordon approve ([0-9a-f]{16})/u.exec(JSON.stringify(reply))?.[1] ?? null
}

async function startGateway(home, log) {
  const gateway = spawn(process.execPath, [BUNDLE, 'mcp', '--', process.execPath, SERVER], {
    cwd: HERE,
    env: { ...process.env, CORDON_HOME: home, SENT_LOG: log },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  gateway.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
  createInterface({ input: gateway.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })
  gateway.on('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('the gateway closed before replying: ' + stderr))
    }
    pending.clear()
  })
  function request(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('the gateway did not answer ' + method + ': ' + stderr))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      gateway.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async function stop() {
    if (gateway.exitCode !== null) return
    const closed = new Promise((resolve) => gateway.once('close', resolve))
    gateway.stdin.end()
    gateway.kill()
    await closed
  }
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'approval-restart-probe', version: '1' } })
  await request('tools/list')
  return { request, stop }
}

async function draft(gateway) {
  const read = await gateway.request('tools/call', { name: 'read_ticket', arguments: { id: '4412' } })
  if (read.result?.isError) throw new Error('the clean ticket was not read')
  return gateway.request('tools/call', { name: 'send_email', arguments: ARGS })
}

const home = mkdtempSync(join(tmpdir(), 'cordon-approval-restart-'))
const log = join(home, 'server.jsonl')
writeFileSync(join(home, 'policy.yaml'), [
  'mode: interactive',
  'task: Read support ticket 4412 and email a short summary of it to ' + OWNER,
  'profile:',
  '  effects: [read, export, network-egress]',
  'tools:',
  '  read_ticket: [read]',
  '  send_email: [export, network-egress]',
  'toolsReturn:',
  '  read_ticket: rendered',
  'notify:',
  '  file: ' + join(home, 'events.jsonl'),
  '',
].join('\n'))

let first
let second
try {
  first = await startGateway(home, log)
  const firstReply = await draft(first)
  const oldId = approvalId(firstReply)
  const firstDraftHeld = firstReply.result?.isError === true && oldId !== null
  if (!firstDraftHeld) throw new Error('the first gateway did not hold the draft')
  await first.stop()
  first = null

  // This is the exact owner CLI, after the old gateway has exited.
  const approved = spawnSync(process.execPath, [BUNDLE, 'approve', oldId], {
    env: { ...process.env, CORDON_HOME: home },
    encoding: 'utf8',
    timeout: 10_000,
  })
  const ownerApprovalRecorded = approved.status === 0 && existsSync(join(home, 'approvals', oldId + '.approved'))
  if (!ownerApprovalRecorded) throw new Error('the owner CLI did not record the old approval: ' + approved.stderr)

  second = await startGateway(home, log)
  const secondReply = await draft(second)
  const newId = approvalId(secondReply)
  const emailReachedServer = existsSync(log) && readFileSync(log, 'utf8').split('\n').some((line) => line.includes('"tool":"send_email"'))
  process.stdout.write(JSON.stringify({
    firstDraftHeld,
    ownerApprovalRecorded,
    retryHeldUnderNewId: secondReply.result?.isError === true && newId !== null && newId !== oldId,
    oldApprovalUnspent: existsSync(join(home, 'approvals', oldId + '.approved')),
    emailReachedServer,
  }) + '\n')
} finally {
  if (first !== null && first !== undefined) await first.stop()
  if (second !== null && second !== undefined) await second.stop()
  rmSync(home, { recursive: true, force: true })
}
