import { liveToolsForArm } from './live-tools-pair-shapes.mjs'

// Preserve the captured order and runner object while omitting one other tool.
export const liveToolsWithoutExtra = (tools, extraName) => {
  liveToolsForArm(tools, 'runnerOnly')
  if (typeof extraName !== 'string' || extraName === 'mcp__runner') {
    throw new Error('invalid omitted tool name')
  }
  const matching = tools.filter((tool) => (tool?.name ?? tool?.type) === extraName)
  if (matching.length !== 1) throw new Error('expected one matching extra declaration')
  return tools.filter((tool) => (tool?.name ?? tool?.type) !== extraName)
}
