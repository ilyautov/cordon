import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type RequestListener, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureBuiltCli, BUILT_CLI } from '../../support/built-cli.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cordon-http-'))
  const work = join(root, 'work')
  const home = join(root, 'owner')
  mkdirSync(work)
  mkdirSync(home)
  writeFileSync(join(home, 'policy.yaml'), [
    'mode: autonomous', 'profile:', '  effects: [read]', 'tools:',
    '  invoice: [read]', '  receipt: [read]', 'notify:', '  file: ' + join(home, 'events.jsonl'),
  ].join('\n'))
  return { cwd: work, env: { ...process.env, CORDON_HOME: home } }
}

function client(url: string, options: ReturnType<typeof setup>) {
  const child = spawn(process.execPath, [BUILT_CLI, 'mcp', '--url', url], options)
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const done = new Promise(resolve => child.once('close', resolve))
  let id = 0
  return {
    async request(method: string, params: unknown = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n')
      const reply = await replies.next()
      if (reply.done) {
        await done
        throw new Error('gateway closed: ' + stderr)
      }
      const row = JSON.parse(reply.value)
      expect(row.id).toBe(id)
      return row
    },
    async next() {
      const reply = await replies.next()
      if (reply.done) throw new Error('gateway closed: ' + stderr)
      return JSON.parse(reply.value)
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
    },
    async close() {
      child.stdin.end()
      return done
    },
  }
}

beforeAll(() => ensureBuiltCli(), 60_000)

describe('MCP over Streamable HTTP', () => {

  it('releases only the reviewed declaration over a stateful HTTP endpoint', async () => {
    const options = setup()
    const calls: string[] = []
    const headers: IncomingHttpHeaders[] = []
    let removed = false
    let revision = 1
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') removed = true
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      const rpc = JSON.parse(body)
      if (rpc.method === 'initialize') {
        res.setHeader('mcp-session-id', 'fixture-session')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
          protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
        } }))
        return
      }
      headers.push(req.headers)
      if (rpc.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const tools = ['invoice', 'receipt'].map(name => ({ name, description: name + ' v' + revision, inputSchema: { type: 'object' } }))
      const result = rpc.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'ok' }] }
      if (rpc.method === 'tools/call') calls.push(rpc.params.name)
      res.setHeader('content-type', 'text/event-stream')
      res.end('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + '\r\n\r\n')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture address')
    const url = 'http://127.0.0.1:' + address.port + '/mcp'
    const gateway = client(url, options)
    try {
      await gateway.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      gateway.notify('notifications/initialized')
      const list = async () => (await gateway.request('tools/list')).result.tools.map((t: {name: string}) => t.name)
      const call = (name: string) => gateway.request('tools/call', { name, arguments: {} })
      expect(await list()).toEqual(['invoice', 'receipt'])
      revision++
      expect(await list()).toEqual([])
      const owner = (...args: string[]) => spawnSync(process.execPath, [BUILT_CLI, 'mcp', ...args], { ...options, encoding: 'utf8' })
      const review = owner('changes')
      expect(review.stdout).toContain(url)
      const id = review.stdout.match(/^(\S+) changed "invoice"$/mu)?.[1]
      expect(id).toBeTruthy()
      expect(owner('approve-change', id!).status).toBe(0)
      expect(await list()).toEqual(['invoice'])
      expect((await call('invoice')).result.content[0].text).toBe('ok')
      expect((await call('receipt')).result.isError).toBe(true)
      expect(calls).toEqual(['invoice'])
      expect(owner('approve', '--url', url + '/other').status).toBe(1)
      expect(owner('changes').stdout).toContain('changed "receipt"')
      expect(owner('approve', '--url', url).status).toBe(0)
      expect(owner('changes').stdout).not.toContain('changed "receipt"')
      expect(headers.length).toBeGreaterThan(3)
      for (const h of headers) {
        expect(h['mcp-session-id']).toBe('fixture-session')
        expect(h['mcp-protocol-version']).toBe('2025-11-25')
        expect(h.accept).toContain('text/event-stream')
      }
    } finally {
      await gateway.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    expect(removed).toBe(true)
  })
})

const hello = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'client', version: '1' } }
const ready = { protocolVersion: hello.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
const catalog = { tools: [{ name: 'invoice', inputSchema: { type: 'object' } }] }

type Client = ReturnType<typeof client>

async function withServer(handle: RequestListener, run: (gateway: Client) => Promise<void>): Promise<void> {
  const server = createServer(handle)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture address')
  const gateway = client('http://127.0.0.1:' + address.port, setup())
  try {
    await run(gateway)
  } finally {
    await gateway.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function body(req: AsyncIterable<Uint8Array>) {
  let value = ''
  for await (const chunk of req) value += chunk
  return JSON.parse(value)
}

function json(res: ServerResponse, id: number, result: unknown) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function event(res: ServerResponse, message: unknown) {
  res.write('data: ' + JSON.stringify(message) + '\n\n')
}

it('answers a ping on the initializing stream using the assigned session', async () => {
  let init: ServerResponse
  let pongSession: string | string[] | undefined
  await withServer(async (req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(204).end()
      return
    }
    const rpc = await body(req)
    if (rpc.method === 'initialize') {
      init = res
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'starting' })
      event(res, { jsonrpc: '2.0', id: 'server-ping', method: 'ping' })
    } else {
      pongSession = req.headers['mcp-session-id']
      res.writeHead(202).end()
      event(init, { jsonrpc: '2.0', id: 1, result: ready })
      init.end()
    }
  }, async gateway => {
    expect((await gateway.request('initialize', hello)).result.protocolVersion).toBe(hello.protocolVersion)
    expect(pongSession).toBe('starting')
  })
})

it.each([true, false])('requires a screened handshake and initialized notification (valid hello: %s)', async valid => {
  const methods: string[] = []
  await withServer(async (req, res) => {
    const rpc = await body(req)
    methods.push(rpc.method)
    json(res, rpc.id, rpc.method === 'initialize' ? valid ? ready : { ...ready, serverInfo: null } : catalog)
  }, async gateway => {
    const init = await gateway.request('initialize', hello)
    expect(Boolean(init.result)).toBe(valid)
    if (!valid) gateway.notify('notifications/initialized')
    await expect(gateway.request('tools/list')).rejects.toThrow(/initializ/u)
    expect(methods).toEqual(['initialize'])
  })
})

it('establishes the advertised change stream before discovery and invalidates a cached list', async () => {
  let stream: ServerResponse | undefined
  let listening = false
  let discoveryBeforeStream = false
  await withServer(async (req, res) => {
    if (req.method === 'GET') {
      stream = res
      await new Promise(resolve => setTimeout(resolve, 60))
      listening = true
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders()
      return
    }
    const rpc = await body(req)
    if (rpc.method === 'initialize') json(res, rpc.id, { ...ready, capabilities: { tools: { listChanged: true } } })
    else if (rpc.id === undefined) res.writeHead(202).end()
    else {
      discoveryBeforeStream ||= !listening
      json(res, rpc.id, catalog)
    }
  }, async gateway => {
    await gateway.request('initialize', hello)
    gateway.notify('notifications/initialized')
    expect((await gateway.request('tools/list')).result.tools).toHaveLength(1)
    expect(discoveryBeforeStream).toBe(false)
    event(stream!, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    expect((await gateway.next()).method).toBe('notifications/tools/list_changed')
    expect((await gateway.request('tools/call', { name: 'invoice', arguments: {} })).result.isError).toBe(true)
    expect((await gateway.request('tools/list')).result.tools).toHaveLength(1)
  })
})

it.each(['wrong id', 'mixed envelope', 'disconnect'])('stops without replay after %s', async fault => {
  const calls: number[] = []
  await withServer(async (req, res) => {
    const rpc = await body(req)
    if (rpc.method === 'initialize') json(res, rpc.id, ready)
    else if (rpc.id === undefined) res.writeHead(202).end()
    else if (rpc.method === 'tools/list') json(res, rpc.id, catalog)
    else {
      calls.push(rpc.id)
      if (fault === 'disconnect') res.destroy()
      else if (fault === 'wrong id') json(res, rpc.id + 1, {})
      else {
        res.setHeader('content-type', 'text/event-stream')
        event(res, { jsonrpc: '2.0', id: rpc.id, method: '', result: {} })
        res.end()
      }
    }
  }, async gateway => {
    await gateway.request('initialize', hello)
    gateway.notify('notifications/initialized')
    await gateway.request('tools/list')
    await expect(gateway.request('tools/call', { name: 'invoice', arguments: {} })).rejects.toThrow('gateway closed')
    expect(calls).toHaveLength(1)
  })
})

it('discovers a schema with result fields named title and description and checks their own annotations', async () => {
  const row = { type: 'object', properties: {
    title: { type: 'string', description: 'Published title' },
    description: { type: 'string', title: 'Summary' },
  } }
  const outputSchema = { type: 'object', properties: { results: { type: 'array', items: row } },
    dependentRequired: { title: ['results'] }, examples: [{ title: 1, properties: { count: 2 } }] }
  await withServer(async (req, res) => {
    const rpc = await body(req)
    if (rpc.method === 'initialize') json(res, rpc.id, ready)
    else if (rpc.id === undefined) res.writeHead(202).end()
    else json(res, rpc.id, { tools: [{ ...catalog.tools[0], outputSchema }] })
  }, async gateway => {
    await gateway.request('initialize', hello)
    gateway.notify('notifications/initialized')
    const list = await gateway.request('tools/list')
    expect(list.result?.tools[0].outputSchema).toEqual(outputSchema)
    Object.assign(row.properties.title, { description: {} })
    expect((await gateway.request('tools/list')).error).toBeDefined()
  })
})

it('supports endpoints that decline GET and requires discovery before the first tool call', async () => {
  const methods: string[] = []
  await withServer(async (req, res) => {
    if (req.method === 'GET') {
      methods.push('GET')
      res.writeHead(405).end()
      return
    }
    const rpc = await body(req)
    methods.push(rpc.method)
    if (rpc.method === 'initialize') json(res, rpc.id, { ...ready, capabilities: { tools: { listChanged: true } } })
    else if (rpc.id === undefined) res.writeHead(202).end()
    else json(res, rpc.id, catalog)
  }, async gateway => {
    await gateway.request('initialize', hello)
    gateway.notify('notifications/initialized')
    expect((await gateway.request('tools/call', { name: 'invoice', arguments: {} })).result.isError).toBe(true)
    expect((await gateway.request('tools/list')).result.tools).toHaveLength(1)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'GET', 'tools/list'])
  })
})

it('refuses an endpoint redirect without sending its request to a second path', async () => {
  const paths: string[] = []
  await withServer((req, res) => {
    paths.push(req.url!)
    res.writeHead(307, { location: '/other' }).end()
  }, async gateway => {
    await expect(gateway.request('initialize', hello)).rejects.toThrow('gateway closed')
    expect(paths).toEqual(['/'])
  })
})

it('bounds a multibyte SSE event by its UTF-8 size', async () => {
  await withServer(async (req, res) => {
    await body(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(':' + '界'.repeat(1_400_000) + '\n\n')
  }, async gateway => {
    await expect(gateway.request('initialize', hello)).rejects.toThrow('event exceeds the size limit')
  })
})

it('rejects non-TLS remote URLs and credentials before loading the gateway', () => {
  const options = setup()
  for (const url of ['http://docs.example/mcp', 'https://private-value@docs.example/mcp', 'https://docs.example/mcp?private-value', 'https://docs.example/#private-value']) {
    const result = spawnSync(process.execPath, [BUILT_CLI, 'mcp', '--url', url], { ...options, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('HTTPS endpoint')
    expect(result.stderr).not.toContain('private-value')
  }
})
