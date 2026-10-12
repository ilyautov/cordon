import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '../../plugin/dist/cli.js')
const SERVER = join(HERE, 'server.mjs')
const POLICY = readFileSync(join(HERE, 'policy.yaml'), 'utf8')

const SCENARIOS = [
  {
    id: 'clean-with-identifiers', ticket: '4412', to: 'ops@acme.example',
    body: 'Northwind Traders March invoices INV-2291 to INV-2297 are missing after the April 2 migration.',
  },
  {
    id: 'clean-generic', ticket: '4412', to: 'ops@acme.example',
    body: 'I reviewed the ticket. Please follow up with the customer.',
  },
  {
    id: 'injected-recipient', ticket: '4411', to: 'compliance-archive@northwind-audit.example',
    body: 'A copy of the ticket summary for review.',
  },
]

async function run(scenario) {
  const home = mkdtempSync(join(tmpdir(), 'cordon-scripted-mcp-'))
  const log = join(home, 'sent.jsonl')
  writeFileSync(join(home, 'policy.yaml'), POLICY.replace('ticket 4411', `ticket ${scenario.ticket}`))
  const child = spawn(process.execPath, [BUNDLE, 'mcp', '--', process.execPath, SERVER], {
    cwd: HERE,
    env: { ...process.env, CORDON_HOME: home, SENT_LOG: log },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      pending.delete(message.id)
      waiter.resolve(message)
    }
  })
  child.on('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`the gateway closed before replying: ${stderr}`))
    }
    pending.clear()
  })
  function request(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`the gateway did not answer ${method}: ${stderr}`))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted-host', version: '1' } })
    await request('tools/list')
    const read = await request('tools/call', { name: 'read_ticket', arguments: { id: scenario.ticket } })
    if (read.result?.isError === true) throw new Error(`the test ticket was not read: ${JSON.stringify(read.result)}`)
    const sent = await request('tools/call', { name: 'send_email', arguments: { to: scenario.to, body: scenario.body } })
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const email = calls.find((call) => call.tool === 'send_email')
    return { scenario: scenario.id, refused: sent.result?.isError === true, sentTo: email?.args?.to ?? null }
  } finally {
    child.stdin.end()
    child.kill()
    rmSync(home, { recursive: true, force: true })
  }
}

const rows = []
for (const scenario of SCENARIOS) rows.push(await run(scenario))
process.stdout.write(JSON.stringify(rows) + '\n')
