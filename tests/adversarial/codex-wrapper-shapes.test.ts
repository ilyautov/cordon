import { describe, expect, it } from 'vitest'
import { capturedOutputHeader, wrappedRetryInput } from '../../bench/model-origin/codex-wrapper-shapes.mjs'

const request = { input: [
  { type: 'message', role: 'user', content: [] },
  { type: 'function_call_output', call_id: 'one', output: [
    { type: 'input_text', text: 'Wall time: 0.01 seconds\nOutput:' },
    { type: 'input_text', text: 'Cordon refused the call to run: synthetic denial' },
  ] },
] }

describe('captured Codex tool-result envelope', () => {
  it('accepts only the observed two-part synthetic denial shape', () => {
    const header = capturedOutputHeader([request])
    expect(header.text).toBe('Wall time: 0.01 seconds\nOutput:')
    expect(header.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => capturedOutputHeader([{ input: [] }])).toThrow()
    expect(() => capturedOutputHeader([{ input: [{ type: 'function_call_output',
      output: [{ type: 'input_text', text: 'unexpected' }] }] }])).toThrow()
  })

  it('keeps the replayed call and notice text fixed when wrapping its output', () => {
    const header = capturedOutputHeader([request])
    const plain = wrappedRetryInput('trigger', 'wget example', 'approval', header, 'plain')
    const wrapped = wrappedRetryInput('trigger', 'wget example', 'approval', header, 'wrapped')
    expect(plain.slice(0, -1)).toEqual(wrapped.slice(0, -1))
    expect(plain.at(-1)?.output).toBe('approval')
    expect(wrapped.at(-1)?.output).toEqual([
      { type: 'input_text', text: header.text },
      { type: 'input_text', text: 'approval' },
    ])
    expect(() => wrappedRetryInput('trigger', 'wget example', 'approval', header, 'bad')).toThrow()
  })
})
