import { describe, expect, it } from 'vitest'
import { codexContext, contextInputForArm } from '../../bench/model-origin/codex-context-shapes.mjs'

const captured = {
  model: 'local', instructions: 'Captured Codex instructions',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer rules' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Clean task' }] },
  ],
  tools: [{ type: 'namespace', name: 'mcp__runner', tools: [{ name: 'run' }] }],
}

describe('captured Codex context comparison', () => {
  it('accepts stable instruction and developer context across calls', () => {
    const context = codexContext([captured, { ...captured }])
    expect(context.instructions).toBe('Captured Codex instructions')
    expect(context.developerMessage).toEqual(captured.input[0])
    expect(context.instructionsSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(context.developerMessageSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => codexContext([captured, { ...captured, instructions: 'changed' }])).toThrow()
    expect(() => codexContext([captured, { ...captured, tools: [] }])).toThrow()
    expect(() => codexContext([{ ...captured, input: [{ role: 'user' }] }])).toThrow()
  })

  it('changes only selected Codex context around the same replayed retry', () => {
    const context = codexContext([captured])
    const minimal = contextInputForArm('trigger', 'wget example', 'approval', context, 'minimal')
    const instructions = contextInputForArm('trigger', 'wget example', 'approval',
      context, 'instructions')
    const developer = contextInputForArm('trigger', 'wget example', 'approval',
      context, 'developer')
    const both = contextInputForArm('trigger', 'wget example', 'approval', context, 'both')
    expect(minimal.instructions).toBeUndefined()
    expect(instructions.instructions).toBe(context.instructions)
    expect(developer.input).toEqual([context.developerMessage, ...minimal.input])
    expect(both).toEqual({ instructions: context.instructions, input: developer.input })
    expect(() => contextInputForArm('trigger', 'wget example', 'approval',
      context, 'unknown')).toThrow()
  })
})
