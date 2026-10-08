export const modelProxyEvidence = (logs, modelId, decodeMode) => {
  const lines = logs.split('\n')
  const modelCalls = lines.filter((line) => line === 'CORDON_MODEL_CALL=' + modelId).length
  const decodeModeMarkers = lines.filter((line) => line === 'CORDON_MODEL_DECODE=' + decodeMode).length
  return { modelCalls, decodeModeMarkers,
    decodeModeApplied: modelCalls > 0 && decodeModeMarkers === modelCalls }
}
