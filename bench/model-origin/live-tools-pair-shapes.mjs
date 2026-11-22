// Use the exact runner object from the captured Codex request in both arms.
// Only the other model-visible declarations vary.
export const liveToolsForArm = (tools, arm) => {
  if (!Array.isArray(tools)) throw new Error('expected captured model tools')
  const runners = tools.filter((tool) => tool?.type === 'namespace' &&
    tool.name === 'mcp__runner')
  if (runners.length !== 1 || runners[0].tools?.length !== 1 ||
    runners[0].tools[0]?.name !== 'run' ||
    runners[0].tools[0]?.parameters?.properties?.command?.type !== 'string') {
    throw new Error('captured runner declaration does not match the benchmark tool')
  }
  if (arm === 'runnerOnly') return runners
  if (arm === 'allTools') return tools
  throw new Error('unknown live tool arm')
}

export const liveToolsWithExtras = (tools, extraNames) => {
  liveToolsForArm(tools, 'runnerOnly')
  if (!Array.isArray(extraNames) || new Set(extraNames).size !== extraNames.length ||
    extraNames.includes('mcp__runner')) throw new Error('invalid extra tool names')
  const selected = tools.filter((tool) => tool?.name === 'mcp__runner' ||
    extraNames.includes(tool?.name ?? tool?.type))
  if (selected.length !== extraNames.length + 1) {
    throw new Error('captured tool list is missing an extra declaration')
  }
  return selected
}
