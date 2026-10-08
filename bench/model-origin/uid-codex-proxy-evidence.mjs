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
