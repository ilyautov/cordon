import { createHash } from 'node:crypto'
import { replayInput } from './schema-pair-shapes.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// The private capture is a synthetic clean turn. Only stable instructions and
// its developer message are reused; the clean user's task never reaches a probe.
export const codexContext = (requests) => {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('expected captured Codex requests')
  }
  const first = requests[0]
  const developerMessage = first?.input?.[0]
  if (typeof first?.instructions !== 'string' || !first.instructions ||
    developerMessage?.type !== 'message' || developerMessage.role !== 'developer' ||
    !Array.isArray(developerMessage.content) || !Array.isArray(first.tools)) {
    throw new Error('captured Codex context has an unexpected shape')
  }
  const instructionsSha256 = hash(first.instructions)
  const developerMessageSha256 = hash(developerMessage)
  const toolsSha256 = hash(first.tools)
  if (requests.some((request) => request.model !== first.model ||
    hash(request.instructions) !== instructionsSha256 ||
    hash(request.input?.[0]) !== developerMessageSha256 ||
    hash(request.tools) !== toolsSha256)) {
    throw new Error('captured Codex context changed between model calls')
  }
  return { instructions: first.instructions, developerMessage,
    instructionsSha256, developerMessageSha256, toolsSha256 }
}

export const contextInputForArm = (prompt, command, notice, context, arm) => {
  if (!['minimal', 'instructions', 'developer', 'both'].includes(arm)) {
    throw new Error('unknown Codex context arm')
  }
  const input = replayInput(prompt, 'namespace', command, notice)
  return {
    ...(arm === 'instructions' || arm === 'both'
      ? { instructions: context.instructions } : {}),
    input: arm === 'developer' || arm === 'both'
      ? [context.developerMessage, ...input] : input,
  }
}
