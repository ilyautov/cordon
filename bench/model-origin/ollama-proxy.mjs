// The agent's internal Docker network reaches this one Responses endpoint.
// The proxy has external access to the host's local Ollama but no owner files.
import { createServer, request as requestHttp } from 'node:http'
import { createHash } from 'node:crypto'
import { withDecodingOptions, withToolFilter } from './ollama-proxy-options.mjs'

const model = process.env.CORDON_MODEL_ID
const decodeMode = process.env.CORDON_MODEL_DECODE || 'passthrough'
const toolFilter = process.env.CORDON_MODEL_TOOL_FILTER || 'passthrough'
const upstream = new URL(process.env.CORDON_MODEL_UPSTREAM || '')
const port = Number(process.env.CORDON_MODEL_PORT || 11435)
if (!model || upstream.protocol !== 'http:' || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('model, HTTP upstream, and port are required')
}
withDecodingOptions({}, decodeMode)
if (!['passthrough', 'runner-only'].includes(toolFilter)) throw new Error('unknown local-model tool filter')

const reject = (response, status, message) => {
  response.writeHead(status, { 'content-type': 'text/plain' })
  response.end(message)
}
const toolDeclarationSummary = (tool) => {
  const parameters = tool?.parameters ?? tool?.function?.parameters
  const properties = parameters?.properties
  return {
    type: typeof tool?.type === 'string' ? tool.type.slice(0, 80) : null,
    name: typeof (tool?.name ?? tool?.function?.name) === 'string'
      ? (tool.name ?? tool.function.name).slice(0, 120) : null,
    sha256: createHash('sha256').update(JSON.stringify(tool)).digest('hex'),
    declarationKeys: tool && typeof tool === 'object' && !Array.isArray(tool)
      ? Object.keys(tool).slice(0, 40).map((key) => key.slice(0, 120)) : [],
    parameterKeys: properties && typeof properties === 'object' && !Array.isArray(properties)
      ? Object.keys(properties).slice(0, 40).map((key) => key.slice(0, 120)) : [],
  }
}
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    reject(response, 403, 'Responses only')
    return
  }
  let body = ''
  try {
    for await (const part of request) {
      body += part.toString('utf8')
      if (body.length > 2_000_000) {
        reject(response, 413, 'Request too large')
        return
      }
    }
  } catch (error) {
    if (!response.writableEnded) reject(response, 400, 'Invalid request body')
    process.stderr.write('model proxy request read failed: ' + String(error) + '\n')
    return
  }
  let input
  try { input = JSON.parse(body) }
  catch { reject(response, 400, 'Invalid JSON'); return }
  if (input?.model !== model) {
    reject(response, 403, 'Model not allowed')
    return
  }
  let filtered
  try { filtered = withToolFilter(input, toolFilter) }
  catch (error) {
    process.stderr.write('model proxy tool filter failed: ' + error.message + '\n')
    reject(response, 422, 'Required runner tool unavailable')
    return
  }
  const sourceToolCount = Array.isArray(input.tools) ? input.tools.length : 0
  const visibleTools = Array.isArray(filtered.tools) ? filtered.tools : []
  const toolSummary = { count: visibleTools.length,
    truncated: visibleTools.length > 64,
    tools: visibleTools.slice(0, 64).map((tool) => {
      return {
        ...toolDeclarationSummary(tool),
        ...(Array.isArray(tool?.tools) ? { members: {
          count: tool.tools.length, truncated: tool.tools.length > 32,
          tools: tool.tools.slice(0, 32).map(toolDeclarationSummary),
        } } : {}),
      }
    }) }
  const forwardedBody = JSON.stringify(withDecodingOptions(filtered, decodeMode))
  process.stderr.write('CORDON_MODEL_CALL=' + model + '\n')
  process.stderr.write('CORDON_MODEL_DECODE=' + decodeMode + '\n')
  process.stderr.write('CORDON_MODEL_TOOL_FILTER=' + toolFilter + '\n')
  process.stderr.write('CORDON_MODEL_SOURCE_TOOL_COUNT=' + sourceToolCount + '\n')
  // Names and hashes reveal the model-visible tool contract without logging
  // owner prompts, tool descriptions, arguments, or model responses.
  process.stderr.write('CORDON_MODEL_TOOLS=' + JSON.stringify(toolSummary) + '\n')
  // Opt-in capture is for matched-schema bench probes. Keep it separate from
  // the normal privacy-preserving log, and never serialize the request input.
  if (process.env.CORDON_MODEL_CAPTURE_TOOLS === '1') {
    process.stderr.write('CORDON_MODEL_TOOL_DECLARATIONS=' +
      JSON.stringify(visibleTools) + '\n')
  }
  // This captures the exact forwarded request only in a disposable local-model
  // benchmark. It can contain prompt text, so the caller keeps it in private
  // scratch and never includes it in the published result.
  if (process.env.CORDON_MODEL_CAPTURE_REQUESTS === '1') {
    process.stderr.write('CORDON_MODEL_REQUEST=' + forwardedBody + '\n')
  }
  const target = new URL('/v1/responses', upstream)
  const forwarded = requestHttp(target, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(forwardedBody) },
    timeout: 180_000,
  }, (reply) => {
    response.writeHead(reply.statusCode || 502, {
      'content-type': reply.headers['content-type'] || 'application/json',
    })
    reply.pipe(response)
  })
  forwarded.on('timeout', () => forwarded.destroy(new Error('model upstream timed out')))
  forwarded.on('error', (error) => {
    process.stderr.write('model proxy upstream failed: ' + error.message + '\n')
    if (!response.headersSent) reject(response, 502, 'Model upstream failed')
    else response.destroy(error)
  })
  response.on('close', () => forwarded.destroy())
  forwarded.end(forwardedBody)
})
server.on('error', (error) => {
  process.stderr.write('model proxy server failed: ' + error.message + '\n')
  process.exitCode = 1
})
server.listen(port, '0.0.0.0', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('model proxy address missing')
  process.stderr.write('CORDON_MODEL_READY=' + address.port + '\n')
})
