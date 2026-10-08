// Narrow model endpoint for the separate-UID poisoned-weight host. The proxy
// has no owner files and forwards only chat completions for one pinned model.
import { createServer, request as requestHttp } from 'node:http'

const model = process.env.CORDON_MODEL_ID
const upstream = new URL(process.env.CORDON_MODEL_UPSTREAM || '')
const port = Number(process.env.CORDON_MODEL_PORT ?? 11435)
if (!model || upstream.protocol !== 'http:' || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('model, HTTP upstream, and valid port are required')
}

const reject = (response, status, message) => {
  response.writeHead(status, { 'content-type': 'text/plain' })
  response.end(message)
}
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    reject(response, 403, 'Chat completions only')
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
    process.stderr.write('chat proxy request read failed: ' + String(error) + '\n')
    return
  }
  let input
  try { input = JSON.parse(body) }
  catch { reject(response, 400, 'Invalid JSON'); return }
  if (input?.model !== model || input.stream !== false || input.temperature !== 0 ||
    input.max_tokens !== 180) {
    reject(response, 403, 'Model or decoding options not allowed')
    return
  }
  const target = new URL('/v1/chat/completions', upstream)
  process.stderr.write('CORDON_MODEL_CALL=' + model + '\n')
  const forwarded = requestHttp(target, {
    method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body) }, timeout: 90_000,
  }, (reply) => {
    response.writeHead(reply.statusCode || 502, {
      'content-type': reply.headers['content-type'] || 'application/json',
    })
    reply.pipe(response)
  })
  forwarded.on('timeout', () => forwarded.destroy(new Error('chat upstream timed out')))
  forwarded.on('error', (error) => {
    process.stderr.write('chat proxy upstream failed: ' + error.message + '\n')
    if (!response.headersSent) reject(response, 502, 'Model upstream failed')
    else response.destroy(error)
  })
  response.on('close', () => forwarded.destroy())
  forwarded.end(body)
})
server.on('error', (error) => {
  process.stderr.write('chat proxy server failed: ' + error.message + '\n')
  process.exitCode = 1
})
server.listen(port, '0.0.0.0', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('chat proxy address missing')
  process.stderr.write('CORDON_MODEL_READY=' + address.port + '\n')
})
