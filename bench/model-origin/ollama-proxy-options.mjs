export const withDecodingOptions = (request, mode) => {
  if (mode === 'passthrough') return request
  if (mode === 'greedy-seed7') {
    return { ...request, temperature: 0, top_p: 1, seed: 7 }
  }
  throw new Error('unknown local-model decoding mode')
}

export const withToolFilter = (request, mode) => {
  if (mode === 'passthrough') return request
  if (mode !== 'runner-only') throw new Error('unknown local-model tool filter')
  const tools = Array.isArray(request?.tools) ? request.tools : []
  const runners = tools.filter((tool) => tool?.name === 'mcp__runner')
  const runner = runners[0]
  const member = runner?.tools?.[0]
  if (runners.length !== 1 || runner?.type !== 'namespace' ||
    !Array.isArray(runner.tools) || runner.tools.length !== 1 ||
    member?.type !== 'function' || member.name !== 'run' ||
    member.parameters?.properties?.command?.type !== 'string') {
    throw new Error('runner-only tool filter requires one runner namespace with one run function')
  }
  return { ...request, tools: [runner] }
}
