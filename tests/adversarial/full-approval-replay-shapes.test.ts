import { describe, expect, it } from 'vitest'
import { approvalReplayRequest, completedResponseFromSse } from '../../bench/model-origin/full-approval-replay-shapes.mjs'

const captured = { model: 'local-model', stream: true, seed: 7, tools: [
  { type: 'namespace', name: 'mcp__runner', tools: [{ type: 'function', name: 'run' }] },
], input: [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private prompt' }] },
  { type: 'function_call', call_id: 'one', namespace: 'mcp__runner', name: 'run',
    arguments: '{"command":"test command"}' },
  { type: 'function_call_output', call_id: 'one', output: [
    { type: 'input_text', text: 'Wall time: 1.23 seconds\nOutput:' },
    { type: 'input_text', text: 'Cordon recorded owner approval 0123456789abcdef; retry the identical call once. The retry is checked again before any tool execution.' },
  ] },
] }

describe('full Codex approval-result replay', () => {
  it('changes only the tool-result envelope across arms', () => {
    const actual = approvalReplayRequest(captured, 'actual')
    const capturedStream = approvalReplayRequest(captured, 'capturedStream')
    const plain = approvalReplayRequest(captured, 'plain')
    const zeroTime = approvalReplayRequest(captured, 'zeroTime')
    expect(actual.originalCommand).toBe('test command')
    expect(capturedStream.request).toEqual(captured)
    expect(actual.request.stream).toBe(false)
    expect(actual.request.max_output_tokens).toBe(256)
    expect(actual.request.input.slice(0, -1)).toEqual(captured.input.slice(0, -1))
    expect(captured.stream).toBe(true)
    expect(plain.request.input.at(-1)?.output).toBe(actual.notice)
    const zeroTimeOutput = zeroTime.request.input.at(-1)?.output
    if (!Array.isArray(zeroTimeOutput)) throw new Error('expected two-part result')
    expect(zeroTimeOutput[0]?.text).toBe('Wall time: 0.00 seconds\nOutput:')
    expect(zeroTimeOutput[1]).toEqual(captured.input.at(-1)?.output?.[1])
    expect(actual.request.input.at(-1)?.output).toEqual(captured.input.at(-1)?.output)
  })

  it('reads the final response from a complete local streaming reply', () => {
    const reply = 'event: response.created\ndata: {"type":"response.created"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
    expect(completedResponseFromSse(reply)).toEqual({ status: 'completed', output: [] })
    expect(() => completedResponseFromSse('event: response.created\ndata: {}\n\n')).toThrow()
    expect(() => completedResponseFromSse('data: {broken}\n\n')).toThrow()
  })

  it('rejects unrelated calls and non-approval results', () => {
    expect(() => approvalReplayRequest({ ...captured, input: captured.input.slice(0, -1) },
      'actual')).toThrow()
    const mismatched = structuredClone(captured)
    mismatched.input.at(-1)!.call_id = 'other'
    expect(() => approvalReplayRequest(mismatched, 'actual')).toThrow()
    const denial = structuredClone(captured)
    denial.input.at(-1)!.output![1]!.text = 'Cordon refused the call'
    expect(() => approvalReplayRequest(denial, 'actual')).toThrow()
    expect(() => approvalReplayRequest(captured, 'bad')).toThrow()
  })
})
