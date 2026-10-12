// A synthetic MCP resource for a live Codex transport control. The method
// log is the authority on whether a refused read reached the upstream.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const URI = 'resource://probe/guide'
const TOKEN = ['CORDON', 'RESOURCE', 'CANARY', '6427'].join('_')
const log = process.env.CORDON_RESOURCE_METHOD_LOG

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (log) appendFileSync(log, JSON.stringify({ method: request.method, params: request.params ?? null }) + '\n')
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  if (request.method === 'initialize') {
    reply({ protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { resources: {} }, serverInfo: { name: 'cordon-resource-probe', version: '1.0.0' } })
    return
  }
  if (request.method === 'tools/list') return reply({ tools: [] })
  if (request.method === 'resources/list') {
    return reply({ resources: [{ uri: URI, name: 'guide', description: 'A synthetic public test resource.' }] })
  }
  if (request.method === 'resources/read') {
    if (request.params?.uri !== URI) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32602, message: 'unknown resource' } }) + '\n')
      return
    }
    reply({ contents: [{ uri: URI, mimeType: 'text/plain', text: `The token is ${TOKEN}.` }] })
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
    error: { code: -32601, message: 'method not found' } }) + '\n')
})
