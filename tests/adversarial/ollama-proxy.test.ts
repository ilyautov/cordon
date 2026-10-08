import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const children: Array<ReturnType<typeof spawn>> = []

afterEach(() => {
  for (const child of children) child.kill('SIGTERM')
  children.length = 0
})

describe('benchmark model proxy', () => {
  it('forwards only Responses calls for the pinned local model', async () => {
    const received: Array<{ method: string | undefined, path: string | undefined, body: unknown }> = []
    const upstream = createServer(async (request, response) => {
      const body = await new Promise<string>((resolve) => {
        let value = ''
        request.setEncoding('utf8').on('data', (part) => { value += part })
        request.on('end', () => resolve(value))
      })
      received.push({ method: request.method, path: request.url, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    try {
      const address = upstream.address()
      if (!address || typeof address === 'string') throw new Error('upstream address missing')
      let stderr = ''
      const child = spawn(process.execPath, [join(process.cwd(), 'bench/model-origin/ollama-proxy.mjs')], {
        env: { ...process.env, CORDON_MODEL_ID: 'qwen2.5:3b',
          CORDON_MODEL_UPSTREAM: `http://127.0.0.1:${address.port}`,
          CORDON_MODEL_PORT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      children.push(child)
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('proxy did not start: ' + stderr)), 5000)
        child.stderr.setEncoding('utf8').on('data', (part) => {
          stderr += part
          const match = stderr.match(/CORDON_MODEL_READY=(\d+)/u)
          if (match) { clearTimeout(timer); resolve(Number(match[1])) }
        })
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error('proxy exited: ' + code + ' ' + stderr)) })
      })
      const base = `http://127.0.0.1:${port}`
      const tool = { type: 'function', name: 'mcp__runner__run',
        description: 'Only a hashed declaration belongs in the proxy log',
        parameters: { type: 'object', properties: { command: { type: 'string' } } } }
      const namespace = { type: 'namespace', name: 'mcp__runner',
        description: 'NESTED_SECRET_DESCRIPTION', tools: [{ type: 'function', name: 'run',
          parameters: { type: 'object', properties: { command: { type: 'string' } } } }] }
      const allowed = await fetch(base + '/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen2.5:3b', input: 'SECRET_CONTENT_MARKER',
          stream: true, tools: [tool, namespace] }),
      })
      expect(allowed.status).toBe(200)
      expect(await allowed.text()).toBe('data: [DONE]\n\n')
      for (const [method, path, model] of [
        ['GET', '/v1/responses', null],
        ['POST', '/api/generate', 'qwen2.5:3b'],
        ['POST', '/v1/responses', 'other-model'],
      ] as const) {
        const denied = await fetch(base + path, {
          method, headers: { 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify({ model }) } : {}),
        })
        expect(denied.status).toBe(403)
      }
      expect(received).toEqual([{ method: 'POST', path: '/v1/responses',
        body: { model: 'qwen2.5:3b', input: 'SECRET_CONTENT_MARKER',
          stream: true, tools: [tool, namespace] } }])
      const summaryLine = stderr.split('\n').find((line) => line.startsWith('CORDON_MODEL_TOOLS='))
      expect(summaryLine).toBeDefined()
      const summary = JSON.parse(summaryLine!.slice('CORDON_MODEL_TOOLS='.length))
      expect(summary.count).toBe(2)
      expect(summary.tools[0].name).toBe('mcp__runner__run')
      expect(summary.tools[0].parameterKeys).toEqual(['command'])
      expect(summary.tools[0].declarationKeys).toEqual(['type', 'name', 'description', 'parameters'])
      expect(summary.tools[0].sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(summary.tools[1].members).toMatchObject({ count: 1, truncated: false,
        tools: [{ type: 'function', name: 'run', parameterKeys: ['command'] }] })
      expect(summary.tools[1].members.tools[0].sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(stderr).not.toContain('SECRET_CONTENT_MARKER')
      expect(stderr).not.toContain('Only a hashed declaration')
      expect(stderr).not.toContain('NESTED_SECRET_DESCRIPTION')
    } finally {
      upstream.close()
    }
  })
})
