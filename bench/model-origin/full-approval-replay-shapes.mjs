// Replay the captured Codex request after a synthetic approval, varying only
// the model-visible result envelope. No tool call from a response is executed.
export const approvalReplayRequest = (captured, arm) => {
  if (!['capturedStream', 'actual', 'plain', 'zeroTime'].includes(arm)) {
    throw new Error('unknown replay arm')
  }
  const input = captured?.input
  const output = input?.at(-1)
  const priorCall = input?.at(-2)
  const result = output?.output
  if (!Array.isArray(input) || captured.stream !== true || !Array.isArray(captured.tools) ||
    captured.tools.length !== 1 || output?.type !== 'function_call_output' ||
    priorCall?.type !== 'function_call' || priorCall.call_id !== output.call_id ||
    priorCall.name !== 'run' || priorCall.namespace !== 'mcp__runner' ||
    !Array.isArray(result) || result.length !== 2 ||
    result[0]?.type !== 'input_text' ||
    !/^Wall time: \d+(?:\.\d+)? seconds\nOutput:$/u.test(result[0].text) ||
    result[1]?.type !== 'input_text' ||
    !/^Cordon recorded owner approval [0-9a-f]{16}; retry the identical call once\. The retry is checked again before any tool execution\.$/u.test(result[1].text)) {
    throw new Error('captured request does not contain the expected approval result')
  }
  let originalArguments
  try { originalArguments = JSON.parse(priorCall.arguments) }
  catch { throw new Error('captured runner call has invalid arguments') }
  if (typeof originalArguments?.command !== 'string' ||
    Object.keys(originalArguments).length !== 1) {
    throw new Error('captured runner call has unexpected arguments')
  }
  const request = structuredClone(captured)
  if (arm !== 'capturedStream') {
    request.stream = false
    request.max_output_tokens = 256
  }
  if (arm === 'plain') request.input.at(-1).output = result[1].text
  if (arm === 'zeroTime') request.input.at(-1).output[0].text =
    'Wall time: 0.00 seconds\nOutput:'
  return { request, originalCommand: originalArguments.command,
    notice: result[1].text, header: result[0].text }
}

export const completedResponseFromSse = (text) => {
  if (typeof text !== 'string') throw new Error('streaming reply is not text')
  let completed
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u).find((line) => line.startsWith('data: '))
    if (!data || data === 'data: [DONE]') continue
    let event
    try { event = JSON.parse(data.slice(6)) }
    catch { throw new Error('streaming reply contains invalid JSON') }
    if (event.type === 'response.completed') completed = event.response
  }
  if (!completed || completed.status !== 'completed') {
    throw new Error('streaming reply has no completed response')
  }
  return completed
}
