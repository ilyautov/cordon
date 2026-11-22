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
})
