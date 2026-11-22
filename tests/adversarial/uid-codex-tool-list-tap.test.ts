import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe('distinct-UID MCP tool-list tap', () => {
  it('passes split JSONL bytes through unchanged and hashes only tool declarations', () => {
    const tools = [{ name: 'run', description: 'isolated runner', inputSchema: { type: 'object' } }]
    const line = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }) + '\n'
    const other = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [] } }) + '\n'
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { Readable } from 'node:stream'
      import { ToolListTap } from './bench/model-origin/uid-codex-tool-list-tap.mjs'
      const tap = new ToolListTap()
      const chunks = [${JSON.stringify(line.slice(0, 13))},
        ${JSON.stringify(line.slice(13) + other)}]
      let output = ''
      for await (const part of Readable.from(chunks).pipe(tap)) output += part.toString('utf8')
      process.stdout.write(JSON.stringify({ output, observation: tap.snapshot() }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({
      output: line + other,
      observation: {
        toolLists: [{ sha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
          names: ['run'] }],
        parseErrors: 0,
        overLimit: false,
      },
    })
  })
})
