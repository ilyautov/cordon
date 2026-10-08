import { createHash } from 'node:crypto'

// Docker puts container stderr in this field even when its own log command
// fails. Never attach that field to a diagnostic while full requests are logged.
export const proxyLogReadFailure = (result) => 'model proxy log read failed' +
  ' (status=' + String(result.status) + ', signal=' + String(result.signal) +
  ', error=' + String(result.error?.code ?? 'none') +
  ', bytes=' + Buffer.byteLength(result.stderr ?? '') + ')'

// Full requests can contain private prompt text. Return them only to the
// benchmark owner process, which writes them into its private scratch folder.
export const capturedModelRequests = (logs, modelCalls, modelId) => {
  const prefix = 'CORDON_MODEL_REQUEST='
  const lines = logs.split('\n').filter((line) => line.startsWith(prefix))
  if (!Number.isInteger(modelCalls) || modelCalls < 1 || lines.length !== modelCalls) {
    return { valid: false, markers: lines.length, reason: 'marker-count' }
  }
  const requests = []
  for (const line of lines) {
    let request
    try { request = JSON.parse(line.slice(prefix.length)) }
    catch { return { valid: false, markers: lines.length, reason: 'invalid-json' } }
    if (!request || typeof request !== 'object' || request.model !== modelId ||
      !('input' in request) || !Array.isArray(request.tools)) {
      return { valid: false, markers: lines.length, reason: 'invalid-request' }
    }
    requests.push(request)
  }
  return { valid: true, markers: lines.length, requests,
    sha256: createHash('sha256').update(JSON.stringify(requests)).digest('hex') }
}
