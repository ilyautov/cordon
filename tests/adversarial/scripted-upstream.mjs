// A scripted upstream MCP server for the cross-transport test.
//
// A real child process speaking newline-delimited JSON-RPC over stdio, as in
// tests/adapters/mcp/fake-server.mjs, but steered by the scenario instead of
// carrying fixed tools:
//   SCRIPTED_TOOLS    JSON list of tool names to advertise.
//   SCRIPTED_RESULTS  JSON object: tool name -> the text its call returns.
// Arguments are echoed back for any tool without a scripted result, so the
// test sees exactly what reached the upstream after a rewrite.
import { createInterface } from 'node:readline'

const tools = JSON.parse(process.env.SCRIPTED_TOOLS ?? '[]')
const results = JSON.parse(process.env.SCRIPTED_RESULTS ?? '{}')

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'tools/list') {
    reply(message.id, {
      tools: tools.map((name) => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object' } })),
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const text = name in results ? results[name] : `ran with ${JSON.stringify(message.params?.arguments ?? {})}`
    reply(message.id, { content: [{ type: 'text', text }] })
    return
  }
  reply(message.id, {})
})
