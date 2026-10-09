import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('local-model proxy decoding options', () => {
  it('pins only decoding fields in the opt-in arm', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { withDecodingOptions } from './bench/model-origin/ollama-proxy-options.mjs'
      const request = { model: 'local', input: [{ role: 'user', content: 'test' }],
        stream: true, temperature: 0.7, top_p: 0.8 }
      process.stdout.write(JSON.stringify([
        withDecodingOptions(request, 'passthrough'),
        withDecodingOptions(request, 'greedy-seed7'),
      ]))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { model: 'local', input: [{ role: 'user', content: 'test' }],
        stream: true, temperature: 0.7, top_p: 0.8 },
      { model: 'local', input: [{ role: 'user', content: 'test' }],
        stream: true, temperature: 0, top_p: 1, seed: 7 },
    ])
  })

  it('keeps only the declared runner in the opt-in tool-surface arm', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { withToolFilter } from './bench/model-origin/ollama-proxy-options.mjs'
      const runner = { type: 'namespace', name: 'mcp__runner', tools: [
        { type: 'function', name: 'run', parameters: { type: 'object',
          properties: { command: { type: 'string' } } } }] }
      const request = { model: 'local', tools: [
        { type: 'function', name: 'view_image' }, runner,
        { type: 'function', name: 'request_user_input' }] }
      process.stdout.write(JSON.stringify({
        original: request,
        filtered: withToolFilter(request, 'runner-only'),
        passthrough: withToolFilter(request, 'passthrough'),
      }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    const result = JSON.parse(output)
    expect(result.filtered.tools).toEqual([result.original.tools[1]])
    expect(result.passthrough).toEqual(result.original)
    expect(result.original.tools).toHaveLength(3)
  })

  it('rejects a missing or ambiguous runner instead of forwarding an empty tool set', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { withToolFilter } from './bench/model-origin/ollama-proxy-options.mjs'
      const runner = { type: 'namespace', name: 'mcp__runner', tools: [
        { type: 'function', name: 'run', parameters: { type: 'object',
          properties: { command: { type: 'string' } } } }] }
      const errors = [[], [runner, runner],
        [{ ...runner, tools: [{ type: 'function', name: 'read' }] }]].map((tools) => {
        try { withToolFilter({ tools }, 'runner-only'); return null }
        catch (error) { return error.message }
      })
      process.stdout.write(JSON.stringify(errors))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      'runner-only tool filter requires one runner namespace with one run function',
      'runner-only tool filter requires one runner namespace with one run function',
      'runner-only tool filter requires one runner namespace with one run function',
    ])
  })
})
