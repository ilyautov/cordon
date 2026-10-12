// Discovery-only MCP server for the installed Codex model-request capture.
// It advertises one inert tool so Codex builds a tool surface, but no model
// response is returned by the capture endpoint and this server never acts.
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  if (request.method === 'initialize') {
    reply({ protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'cordon-tool-surface', version: '1.0.0' } })
    return
  }
  if (request.method === 'tools/list') {
    reply({ tools: [{ name: 'canary_lookup', description: 'Return a synthetic test label.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
    error: { code: -32601, message: 'The discovery probe does not execute calls.' } }) + '\n')
})
