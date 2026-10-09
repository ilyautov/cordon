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
      const child = spawn(process.execPath, [join(process.cwd(), 'bench/model-origin/ollama-proxy.mjs')], {
        env: { ...process.env, CORDON_MODEL_ID: 'qwen2.5:3b',
          CORDON_MODEL_UPSTREAM: `http://127.0.0.1:${address.port}`,
          CORDON_MODEL_PORT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      children.push(child)
      const port = await new Promise<number>((resolve, reject) => {
        let stderr = ''
        const timer = setTimeout(() => reject(new Error('proxy did not start: ' + stderr)), 5000)
        child.stderr.setEncoding('utf8').on('data', (part) => {
          stderr += part
          const match = stderr.match(/CORDON_MODEL_READY=(\d+)/u)
          if (match) { clearTimeout(timer); resolve(Number(match[1])) }
        })
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error('proxy exited: ' + code + ' ' + stderr)) })
      })
      const base = `http://127.0.0.1:${port}`
      const allowed = await fetch(base + '/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen2.5:3b', input: 'test', stream: true }),
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
        body: { model: 'qwen2.5:3b', input: 'test', stream: true } }])
    } finally {
      upstream.close()
    }
  })
})
