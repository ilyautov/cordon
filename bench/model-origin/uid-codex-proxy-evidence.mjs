import { createHash } from 'node:crypto'

export const modelProxyEvidence = (logs, modelId, decodeMode) => {
  const lines = logs.split('\n')
  const modelCalls = lines.filter((line) => line === 'CORDON_MODEL_CALL=' + modelId).length
  const decodeModeMarkers = lines.filter((line) => line === 'CORDON_MODEL_DECODE=' + decodeMode).length
  const markers = lines.filter((line) => line.startsWith('CORDON_MODEL_TOOLS='))
  const variants = new Map()
  let toolSummaryParseErrors = 0
  for (const line of markers) {
    let summary
    try { summary = JSON.parse(line.slice('CORDON_MODEL_TOOLS='.length)) }
    catch { toolSummaryParseErrors++; continue }
    if (!Number.isInteger(summary?.count) || !Array.isArray(summary.tools)) {
      toolSummaryParseErrors++
      continue
    }
    const key = JSON.stringify(summary)
    const existing = variants.get(key)
    variants.set(key, { summary, occurrences: (existing?.occurrences ?? 0) + 1 })
  }
  return { modelCalls, decodeModeMarkers,
    decodeModeApplied: modelCalls > 0 && decodeModeMarkers === modelCalls,
    toolSummaryMarkers: markers.length,
    toolSummaryComplete: modelCalls > 0 && markers.length === modelCalls &&
      toolSummaryParseErrors === 0,
    toolSummaryParseErrors, toolSummaries: [...variants.values()] }
}

export const modelToolDeclarations = (logs, modelCalls) => {
  const prefix = 'CORDON_MODEL_TOOL_DECLARATIONS='
  const lines = logs.split('\n').filter((line) => line.startsWith(prefix))
  if (!Number.isInteger(modelCalls) || modelCalls < 1 || lines.length !== modelCalls) {
    return { valid: false, markers: lines.length, reason: 'marker-count' }
  }
  let tools
  let serialized
  for (const line of lines) {
    let parsed
    try { parsed = JSON.parse(line.slice(prefix.length)) }
    catch { return { valid: false, markers: lines.length, reason: 'invalid-json' } }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { valid: false, markers: lines.length, reason: 'empty-tools' }
    }
    const value = JSON.stringify(parsed)
    if (serialized !== undefined && value !== serialized) {
      return { valid: false, markers: lines.length, reason: 'tool-list-changed' }
    }
    tools = parsed
    serialized = value
  }
  return { valid: true, markers: lines.length, tools,
    sha256: createHash('sha256').update(serialized).digest('hex') }
}
