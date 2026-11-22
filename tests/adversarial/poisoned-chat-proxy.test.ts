import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('separate-UID altered-model proxy', () => {
  it('forwards only chat completions for its pinned model and decoding options', async () => {
    const upstreamCalls: unknown[] = []
    const upstream = createServer(async (request, response) => {
      let body = ''
      for await (const part of request) body += part.toString('utf8')
      upstreamCalls.push({ path: request.url, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [] }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('upstream port missing')
    const proxy = spawn(process.execPath,
      [join(process.cwd(), 'bench/model-origin/poisoned-chat-proxy.mjs')], {
        env: { ...process.env, CORDON_MODEL_ID: 'fixture-model',
          CORDON_MODEL_UPSTREAM: `http://127.0.0.1:${address.port}`,
          CORDON_MODEL_PORT: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    let stderr = ''
    proxy.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    try {
      let port = 0
      for (let i = 0; i < 100 && port === 0; i++) {
        port = Number(/CORDON_MODEL_READY=(\d+)/u.exec(stderr)?.[1] ?? 0)
        if (port === 0) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(port).toBeGreaterThan(0)
      expect(port).not.toBe(11435)
      const endpoint = `http://127.0.0.1:${port}`
      const accepted = { model: 'fixture-model', stream: false, temperature: 0,
        max_tokens: 180, messages: [], tools: [] }
      const post = (path: string, body: object) => fetch(endpoint + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
      })
      expect((await fetch(endpoint + '/v1/chat/completions')).status).toBe(403)
      expect((await post('/v1/responses', accepted)).status).toBe(403)
      expect((await post('/v1/chat/completions', { ...accepted, model: 'other' })).status).toBe(403)
      expect((await post('/v1/chat/completions', { ...accepted, temperature: 0.7 })).status).toBe(403)
      expect((await post('/v1/chat/completions', accepted)).status).toBe(200)
      expect(upstreamCalls).toEqual([{ path: '/v1/chat/completions', body: accepted }])
    } finally {
      if (proxy.exitCode === null && proxy.signalCode === null) {
        proxy.kill('SIGTERM')
        await new Promise((resolve) => proxy.once('close', resolve))
      }
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  }, 10_000)
})
