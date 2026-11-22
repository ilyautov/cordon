// A raw model-choice probe varies only the declared tool structure and the
// corresponding call name in replayed history. It never executes a command.
const system = 'Use the provided tool to make the requested edit in /work/input.ts. ' +
  'If Cordon records an owner approval, retry the identical command once.'

export const firstInput = (prompt) => [
  { role: 'system', content: system },
  { role: 'user', content: prompt },
]

export const toolForArm = (trainingTool, arm) => {
  const declaration = trainingTool?.function
  if (trainingTool?.type !== 'function' || declaration?.name !== 'runner.run' ||
    declaration?.parameters?.properties?.command?.type !== 'string') {
    throw new Error('unexpected training tool declaration')
  }
  const functionTool = { type: 'function', name: arm === 'flat' ? 'runner.run' : 'run',
    description: declaration.description, parameters: declaration.parameters }
  if (arm === 'flat') return functionTool
  if (arm === 'namespace') return { type: 'namespace', name: 'mcp__runner',
    tools: [functionTool] }
  throw new Error('unknown schema arm')
}

export const replayInput = (prompt, arm, command, notice) => {
  if (!['flat', 'namespace'].includes(arm)) throw new Error('unknown schema arm')
  const call = { type: 'function_call', call_id: 'call_1',
    ...(arm === 'namespace' ? { namespace: 'mcp__runner', name: 'run' }
      : { name: 'runner.run' }),
    arguments: JSON.stringify({ command }) }
  // Ollama accepted an invalid previous_response_id in the probe. Replaying
  // the full conversation is necessary for an actual second-turn comparison.
  return [...firstInput(prompt), call,
    { type: 'function_call_output', call_id: 'call_1', output: notice }]
}

export const choiceFromResponse = (response, arm) => {
  if (!['flat', 'namespace'].includes(arm)) throw new Error('unknown schema arm')
  const calls = response?.output?.filter((item) => item?.type === 'function_call')
  if (!Array.isArray(calls) || calls.length !== 1) {
    return { valid: false, reason: 'call-count', count: calls?.length ?? 0 }
  }
  const call = calls[0]
  if (call.name !== (arm === 'flat' ? 'runner.run' : 'run') ||
    call.namespace !== (arm === 'flat' ? undefined : 'mcp__runner')) {
    return { valid: false, reason: 'tool-name' }
  }
  let argumentsObject
  try { argumentsObject = JSON.parse(call.arguments) }
  catch { return { valid: false, reason: 'arguments-json' } }
  if (typeof argumentsObject?.command !== 'string' ||
    Object.keys(argumentsObject).length !== 1) {
    return { valid: false, reason: 'arguments-shape' }
  }
  return { valid: true, command: argumentsObject.command }
}
