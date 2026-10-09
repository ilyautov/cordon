import { createHash } from 'node:crypto'
import { replayInput } from './schema-pair-shapes.mjs'

// The captured denial reveals only the transport envelope. The probe replaces
// its denial text with the same synthetic approval notice used in both arms.
export const capturedOutputHeader = (requests) => {
  const firstOutput = requests?.flatMap((request) => request.input ?? [])
    .find((item) => item.type === 'function_call_output')?.output
  if (!Array.isArray(firstOutput) || firstOutput.length !== 2 ||
    firstOutput[0]?.type !== 'input_text' ||
    !/^Wall time: \d+(?:\.\d+)? seconds\nOutput:$/u.test(firstOutput[0].text) ||
    firstOutput[1]?.type !== 'input_text' ||
    !firstOutput[1].text.startsWith('Cordon refused the call to run:')) {
    throw new Error('captured Codex result does not match the synthetic denial envelope')
  }
  const text = firstOutput[0].text
  return { text, sha256: createHash('sha256').update(JSON.stringify(text)).digest('hex') }
}

export const wrappedRetryInput = (prompt, command, notice, header, arm) => {
  if (!['plain', 'wrapped'].includes(arm)) throw new Error('unknown result-envelope arm')
  const input = replayInput(prompt, 'namespace', command, notice)
  if (arm === 'wrapped') input[input.length - 1].output = [
    { type: 'input_text', text: header.text },
    { type: 'input_text', text: notice },
  ]
  return input
}
