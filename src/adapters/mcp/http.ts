import { parseLine, type Message } from './jsonrpc.js'

// A missing executable can never start a stdio server. This prefix gives a URL
// its own pin namespace while keeping existing command-based pins readable.
export function httpIdentity(endpoint: URL): string[] {
  return ['', 'streamable-http', endpoint.href]
}

export function httpEndpoint(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('expected an absolute MCP endpoint URL')
  }
  const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('use an HTTPS endpoint without user information, query or fragment (HTTP is supported on literal loopback)')
  }
  return url
}

type Rpc = Record<string, unknown>
type ResponseBody = NonNullable<Awaited<ReturnType<typeof fetch>>['body']>
const LIMIT = 4 * 1024 * 1024
const VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25'])

function record(value: unknown): value is Rpc {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function jsonBody(body: ResponseBody): Promise<string> {
  const parts: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of body) {
    bytes += chunk.byteLength
    if (bytes > LIMIT) throw new Error('MCP JSON response exceeds the size limit')
    parts.push(chunk)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
}

/** SSE uses CR, LF or CRLF, including line endings split across reads. */
async function* events(body: ResponseBody): AsyncGenerator<string> {
  let data: string[] = []
  let size = 0
  let field = ''
  let afterCR = false
  let event = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const chunk of body) {
    const text = decoder.decode(chunk, { stream: true })
    for (const part of text.split(/([\r\n])/u)) {
      if (!part) continue
      if (afterCR && part === '\n') {
        afterCR = false
        continue
      }
      afterCR = part === '\r'
      if (!afterCR && part !== '\n') {
        field += part
        size += Buffer.byteLength(part)
        if (size > LIMIT) throw new Error('MCP SSE event exceeds the size limit')
        continue
      }
      if (field === '') {
        const payload = data.join('\n')
        if (payload && (!event || event === 'message')) yield payload
        data = []
        size = 0
        event = ''
      } else {
        const colon = field.indexOf(':')
        const name = colon < 0 ? field : field.slice(0, colon)
        const value = colon < 0 ? '' : field.slice(colon + 1).replace(/^ /u, '')
        if (name === 'data') data.push(value)
        if (name === 'event') event = value
        // Blank data lines also take memory in the event buffer.
        if (++size > LIMIT) throw new Error('MCP SSE event exceeds the size limit')
      }
      field = ''
    }
  }
  decoder.decode()
}

/** The gateway screens every server message. Only its accepted initialize result opens the session. */
export function openHttp(
  endpoint: string, receive: (line: string) => boolean | void, fail: (reason: string) => void,
): { send: (rpc: Rpc) => void; close: () => Promise<void> } {
  const controller = new AbortController()
  let started = false
  let version: string | undefined
  let session: string | null = null
  let wantsEvents = false
  let ready: Promise<void> | undefined
  const headers = () => ({
    accept: 'application/json, text/event-stream',
    ...(version ? { 'mcp-protocol-version': version } : {}),
    ...(session ? { 'mcp-session-id': session } : {}),
  })

  function failed(error: unknown): void {
    // The gateway ends the session. An uncertain request is never replayed.
    if (!controller.signal.aborted) fail(error instanceof Error ? error.message : 'MCP HTTP transport failed')
  }

  async function readNotifications(body: ResponseBody): Promise<void> {
    for await (const line of events(body)) {
      if (parseRpc(line).type === 'response') throw new Error('unexpected response on MCP notification stream')
      receive(line)
    }
    throw new Error('MCP HTTP notification stream closed; reconnect to rediscover tools')
  }

  async function listen(): Promise<void> {
    // A healthy stream can stay open indefinitely. Bound only the connection setup.
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 60_000)
    try {
      const res = await fetch(endpoint, { method: 'GET', headers: { ...headers(), accept: 'text/event-stream' },
        redirect: 'error', signal: AbortSignal.any([controller.signal, timeout.signal]) })
      if (res.status === 405) {
        await res.body?.cancel()
        return
      }
      if (!res.ok || !res.body || mediaType(res) !== 'text/event-stream') throw new Error('MCP HTTP notification stream failed')
      void readNotifications(res.body).catch(failed)
    } finally {
      clearTimeout(timer)
    }
  }

  async function post(rpc: Rpc): Promise<void> {
    const init = rpc.method === 'initialize'
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
    const res = await fetch(endpoint, {
      method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(rpc), signal, redirect: 'error',
    })
    if (!res.ok) throw new Error('MCP endpoint returned HTTP ' + res.status + '; reconnect before retrying')
    if (typeof rpc.method !== 'string' || !Object.hasOwn(rpc, 'id')) {
      if (res.status !== 202) throw new Error('MCP HTTP expected 202 for a notification or response')
      await res.body?.cancel()
      return
    }
    if (!res.body) throw new Error('MCP endpoint returned an empty request response')
    if (init) {
      // A ping on the initialization stream may need its session before the result arrives.
      session = res.headers.get('mcp-session-id')
      if (session !== null && !/^[\x21-\x7e]+$/u.test(session)) throw new Error('invalid MCP HTTP session identifier')
    }
    const accept = (line: string, streamed: boolean): boolean => {
      const message = parseRpc(line)
      if (message.type !== 'response') {
        if (!streamed) throw new Error('MCP HTTP expected a response to its request')
        receive(line)
        return false
      }
      if (message.id !== rpc.id) throw new Error('MCP HTTP response does not match its request')
      const result = message.value.result
      if (init && record(result)) {
        const negotiated = result.protocolVersion
        if (typeof negotiated !== 'string' || !VERSIONS.has(negotiated)) throw new Error('unsupported MCP HTTP handshake version')
        if (receive(line)) {
          version = negotiated
          const caps = result.capabilities
          wantsEvents = record(caps) && ['tools', 'resources', 'prompts'].some(key => {
            const capability = caps[key]
            return record(capability) && capability.listChanged === true
          })
        }
      } else {
        receive(line)
      }
      return true
    }
    switch (mediaType(res)) {
      case 'application/json':
        accept(await jsonBody(res.body), false)
        return
      case 'text/event-stream':
        for await (const line of events(res.body)) if (accept(line, true)) return
        throw new Error('MCP HTTP event stream ended before the request was answered')
      default:
        throw new Error('unsupported MCP HTTP response content type')
    }
  }

  async function send(rpc: Rpc): Promise<void> {
    if (rpc.method === 'initialize') {
      if (started) throw new Error('duplicate MCP HTTP initialization')
      started = true
    } else if (rpc.method === 'notifications/initialized') {
      if (!version || ready) throw new Error('unexpected MCP HTTP initialized notification')
      ready = post(rpc).then(() => wantsEvents ? listen() : undefined)
      await ready
      return
    } else if (!started || (typeof rpc.method === 'string' && rpc.method !== 'ping')) {
      if (!ready) throw new Error('MCP HTTP requires an initialized session')
      await ready
    }
    await post(rpc)
  }

  return {
    send(rpc) { void send(rpc).catch(failed) },
    async close() {
      controller.abort()
      if (session) {
        try {
          const res = await fetch(endpoint, { method: 'DELETE', headers: headers(), redirect: 'error', signal: AbortSignal.timeout(1500) })
          await res.body?.cancel()
        } catch {
          // The session is already closed locally. Cleanup cannot replay or release any call.
        }
      }
    },
  }
}

function parseRpc(text: string): Message {
  let message: Message
  try {
    message = parseLine(text)
  } catch {
    // Keep raw remote bytes out of a terminal diagnostic.
    throw new Error('invalid JSON-RPC envelope from the MCP HTTP endpoint')
  }
  const value = message.value
  const hasId = Object.hasOwn(value, 'id')
  const result = Object.hasOwn(value, 'result')
  const error = Object.hasOwn(value, 'error')
  const invalid = message.type === 'response'
    ? Object.hasOwn(value, 'method') || result === error
    : result || error || (message.type === 'notification' && hasId)
  if (value.jsonrpc !== '2.0' || invalid) throw new Error('invalid JSON-RPC envelope from the MCP HTTP endpoint')
  return message
}

function mediaType(res: Awaited<ReturnType<typeof fetch>>): string {
  return res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
}
