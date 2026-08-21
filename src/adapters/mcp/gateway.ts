import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Cordon } from '../../cordon.js'
import { PATH_KEYS, URL_KEYS, fold } from '../../core/argument-keys.js'
import { makeDirectory } from '../../core/mkdir.js'
import type { Source, ToolCall } from '../../core/types.js'
import type { Policy } from '../../policy/defaults.js'
import { classifySource } from '../../provenance/trust.js'
import { parseError, parseLine, pendingKey, toolError, type Message } from './jsonrpc.js'

export interface GatewayOptions {
  /** The upstream server command: `cordon mcp -- npx server-x` gives ['npx', 'server-x']. */
  command: string[]
  policy: Policy
  cordonHome: string
  /** Injectable for tests; the real process runs on stdin/stdout. */
  hostIn?: Readable
  hostOut?: Writable
  /** Extra environment for the upstream process. Tests steer the fake server through it. */
  env?: Record<string, string>
  /**
   * The loud channel. stderr by default: an MCP host logs a server's stderr,
   * so a line written here reaches the human through the host's own UI.
   */
  log?: (line: string) => void
}

interface Pending {
  method: string
  /** The gated call, kept for a tools/call: the result's source is named by it. */
  call?: ToolCall
  /** The request's own name for the content, for resources/read and prompts/get. */
  label?: string
}

/**
 * Runs the MCP gateway: a stdio proxy between an MCP host and one upstream
 * server. Resolves with the exit code when either side ends.
 *
 * The direction of refusal here is better than the hooks', and the code leans
 * on it: a dead gateway is a dead MCP server, and the host shows that to the
 * human. So every unexpected failure — a broken line from the upstream, a
 * dead upstream, an unusable home directory — stops the process loudly
 * instead of degrading into a proxy that no longer checks anything. There is
 * no fail-open by timeout by construction: the gateway sits inside the pipe,
 * and nothing reaches the model without passing through it.
 */
export function runGateway(options: GatewayOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`cordon mcp: ${line}\n`))
  const hostIn = options.hostIn ?? process.stdin
  const hostOut = options.hostOut ?? process.stdout

  return new Promise((resolve) => {
    let settled = false
    let upstream: ChildProcess | null = null

    // Every exit runs through here, exactly once. Killing the upstream on the
    // way out matters: a host that went away leaves no reader for the
    // upstream's answers, and a orphaned server keeps the machine's
    // resources and the session's state open.
    const finish = (code: number, reason?: string): void => {
      if (settled) return
      settled = true
      if (reason !== undefined) log(reason)
      if (upstream !== null && upstream.exitCode === null && !upstream.killed) upstream.kill()
      resolve(code)
    }

    // Session state is the journal and the memory. A gateway that cannot
    // write it is a proxy with dead provenance that looks alive — the same
    // state the hooks refuse to start in, and here refusing is cheap: the
    // host simply sees a server that failed to start.
    try {
      ensureUsableHome(options.cordonHome)
    } catch (error) {
      finish(1, `the home directory is not usable: ${(error as Error).message}`)
      return
    }

    // The session is derived from the upstream command and the pid: per
    // server and per run. Two gateways never share provenance, and a
    // restarted server starts clean — the exposure mark included, which is
    // the documented way to lift it on this transport: there are no user
    // turns here that could lift it.
    const sessionId =
      `mcp-${createHash('sha256').update(options.command.join(' '), 'utf8').digest('hex').slice(0, 12)}-${process.pid}`

    let cordon: Cordon
    try {
      cordon = new Cordon({ policy: options.policy, cordonHome: options.cordonHome, sessionId })
    } catch (error) {
      finish(1, `the session state is broken: ${(error as Error).message}`)
      return
    }

    // The certificate is the profile for the whole run — there is no user
    // message to widen or narrow it. What the policy can still carry is the
    // human's naming: the task text feeds the exposure exemption, and
    // declareTask is the path that does it without a turn and without
    // lifting the mark.
    if (typeof options.policy.task === 'string' && options.policy.task !== '') {
      cordon.declareTask(options.policy.task)
    }

    upstream = spawn(options.command[0]!, options.command.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...options.env },
    })
    const child = upstream

    child.on('error', (error) => {
      finish(1, `could not start the upstream (${options.command.join(' ')}): ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      // A dead upstream while the host is still talking is a loud failure,
      // not an end of stream: staying alive would mean answering as if the
      // checks still ran.
      const how = code === null ? `signal ${String(signal)}` : `code ${code}`
      finish(code === null || code === 0 ? 1 : code, `the upstream process exited (${how}); the gateway stops with it`)
    })
    // An EPIPE here is the upstream's death already reported by 'exit'.
    child.stdin!.on('error', () => {})

    const sendToHost = (message: Record<string, unknown>): void => {
      hostOut.write(JSON.stringify(message) + '\n')
    }
    const sendUpstream = (message: Record<string, unknown>): void => {
      child.stdin!.write(JSON.stringify(message) + '\n')
    }

    const pending = new Map<string, Pending>()

    const onHostLine = (line: string): void => {
      let message: Message
      try {
        message = parseLine(line)
      } catch {
        // A broken line from the host gets the protocol's own answer and the
        // gateway keeps working: the host is the trusted side of this pipe,
        // and its parser bug is not the upstream's attack.
        sendToHost(parseError('could not parse the message as JSON-RPC'))
        return
      }

      if (message.type !== 'request') {
        // Notifications and the host's answers to the upstream's own
        // requests (sampling, roots) carry nothing the gateway decides on.
        sendUpstream(message.value)
        return
      }

      if (message.method === 'tools/call') {
        gateCall(message, cordon, options.policy, pending, sendToHost, sendUpstream)
        return
      }

      const entry: Pending = { method: message.method }
      const params = asRecord(message.params)
      if (message.method === 'resources/read' && typeof params?.['uri'] === 'string') {
        entry.label = params['uri']
      }
      if (message.method === 'prompts/get' && typeof params?.['name'] === 'string') {
        entry.label = params['name']
      }
      pending.set(pendingKey(message.id), entry)
      sendUpstream(message.value)
    }

    const onUpstreamLine = (line: string): void => {
      let message: Message
      try {
        message = parseLine(line)
      } catch (error) {
        // The untrusted side of the pipe sent garbage. Forwarding it would
        // pass unfiltered bytes to the model; swallowing it would hang the
        // host's waiter forever. What remains is the loud exit — the host
        // reports a dead server, and the human looks at the log.
        finish(1, `the upstream sent a line that is not JSON-RPC: ${(error as Error).message}`)
        return
      }

      if (message.type !== 'response') {
        // The upstream's own requests and notifications go to the host.
        sendToHost(message.value)
        return
      }

      const entry = pending.get(pendingKey(message.id))
      pending.delete(pendingKey(message.id))
      if (entry === undefined) {
        sendToHost(message.value)
        return
      }

      if (entry.method === 'tools/list') {
        sendToHost(observeToolList(message.value, cordon, options.policy))
        return
      }
      if (entry.method === 'tools/call' && entry.call !== undefined) {
        sendToHost(observeToolResult(message.value, entry.call, cordon, options.policy))
        return
      }
      if (entry.method === 'resources/read') {
        sendToHost(observeResourceRead(message.value, entry, cordon, options.policy))
        return
      }
      if (entry.method === 'prompts/get') {
        sendToHost(observePromptsGet(message.value, entry, cordon, options.policy))
        return
      }
      sendToHost(message.value)
    }

    const hostLines = createInterface({ input: hostIn, terminal: false })
    hostLines.on('line', (line) => {
      if (line.trim() === '') return
      try {
        onHostLine(line)
      } catch (error) {
        // The core decides fail-closed on its own, so an exception reaching
        // here is never a swallowed deny — it is the adapter itself breaking,
        // and the loud exit is the only honest answer left.
        finish(1, `a failure while handling the host's message: ${(error as Error).message}`)
      }
    })
    hostLines.on('close', () => finish(0))

    const upstreamLines = createInterface({ input: child.stdout!, terminal: false })
    upstreamLines.on('line', (line) => {
      if (line.trim() === '') return
      try {
        onUpstreamLine(line)
      } catch (error) {
        finish(1, `a failure while handling the upstream's message: ${(error as Error).message}`)
      }
    })
  })
}

/**
 * The decision on a tools/call. The call is gated BEFORE the upstream sees
 * it: a refused call never reaches the server, and the refusal is answered
 * in the protocol's own shape — a CallToolResult with isError — so the model
 * reads the reason as the tool's output instead of inventing a result.
 *
 * `ask` lands as a refusal here. The gateway has no one to ask: MCP carries
 * no way to put the question in front of the human and resume, so the
 * interactive mode's question becomes a denial carrying the same reason.
 */
function gateCall(
  message: Extract<Message, { type: 'request' }>,
  cordon: Cordon,
  policy: Policy,
  pending: Map<string, Pending>,
  sendToHost: (message: Record<string, unknown>) => void,
  sendUpstream: (message: Record<string, unknown>) => void,
): void {
  const params = asRecord(message.params)
  const name = typeof params?.['name'] === 'string' ? params['name'] : ''
  const call: ToolCall = { tool: name, args: asRecord(params?.['arguments']) ?? {} }

  const decision = cordon.gate(call)
  if (decision.kind === 'deny' || decision.kind === 'ask') {
    sendToHost(toolError(message.id, `Cordon refused the call to ${name || '(no tool named)'}: ${decision.reason}`))
    return
  }

  pending.set(pendingKey(message.id), { method: message.method, call })
  if (decision.kind === 'rewrite') {
    // The forwarded request is reserialized: the original line carries the
    // arguments the model wrote, and they are exactly what was cut.
    sendUpstream({ ...message.value, params: { ...params, arguments: decision.args } })
    return
  }
  sendUpstream(message.value)
}

/**
 * Every tool description is observed as what it is: text the server wrote,
 * which the model reads and the human never sees. Tool poisoning hides the
 * instruction exactly here. `mcp-description` is rendered by default, so the
 * hidden layer is cut before the host — and the model — receives the list.
 */
function observeToolList(
  value: Record<string, unknown>,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const tools = asRecord(value['result'])?.['tools']
  if (!Array.isArray(tools)) return value

  for (const tool of tools) {
    const entry = asRecord(tool)
    if (entry === null || typeof entry['description'] !== 'string') continue
    const name = typeof entry['name'] === 'string' ? entry['name'] : ''
    const source = classifySource({ kind: 'mcp-description', label: name, tool: name }, policy)
    const envelope = cordon.observe(entry['description'], source)
    if (envelope.substitute) {
      entry['description'] = envelope.text
    } else if (envelope.findings.length > 0) {
      cordon.notice(name, `a hidden layer was found in the description of ${name}; it was not substituted`, source)
    }
  }
  return value
}

/**
 * Text blocks of a tool's result: observed, and substituted with the cleaned
 * text when the source's view allows it.
 *
 * A block without text — an image, audio, a resource reference — cannot be
 * cleaned, and the model receives it. Silence would read as a check that
 * happened, so the session is marked, and the gate answers from there: the
 * next call beyond reading escalates.
 */
function observeToolResult(
  value: Record<string, unknown>,
  call: ToolCall,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const result = asRecord(value['result'])
  if (result === null) return value
  const content = result['content']
  if (content === undefined) return value
  if (!Array.isArray(content)) {
    cordon.markUnredacted()
    return value
  }

  const source = classifySource({ kind: 'tool', label: sourceLabel(call), tool: call.tool }, policy)
  for (const block of content) {
    const entry = asRecord(block)
    if (entry !== null && entry['type'] === 'text' && typeof entry['text'] === 'string') {
      observeInto(entry, 'text', call.tool, source, cordon)
    } else {
      cordon.markUnredacted()
    }
  }
  return value
}

/**
 * A resource's text. A blob is base64 we cannot see inside — the same case
 * as an image block in a tool result, with the same answer.
 */
function observeResourceRead(
  value: Record<string, unknown>,
  pending: Pending,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const contents = asRecord(value['result'])?.['contents']
  if (contents === undefined) return value
  if (!Array.isArray(contents)) {
    cordon.markUnredacted()
    return value
  }

  for (const item of contents) {
    const entry = asRecord(item)
    if (entry !== null && typeof entry['text'] === 'string') {
      const label = typeof entry['uri'] === 'string' ? entry['uri'] : (pending.label ?? 'resources/read')
      const source = classifySource({ kind: 'tool', label, tool: 'resources/read' }, policy)
      observeInto(entry, 'text', 'resources/read', source, cordon)
    } else {
      cordon.markUnredacted()
    }
  }
  return value
}

/**
 * A prompt's messages. prompts/get is the classic instruction-injection
 * vector — the server writes what lands in the conversation as if it were
 * the user's own words — so the text goes through the same observe path as
 * any other untrusted content.
 */
function observePromptsGet(
  value: Record<string, unknown>,
  pending: Pending,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const messages = asRecord(value['result'])?.['messages']
  if (messages === undefined) return value
  if (!Array.isArray(messages)) {
    cordon.markUnredacted()
    return value
  }

  const label = pending.label ?? 'prompts/get'
  const source = classifySource({ kind: 'tool', label, tool: 'prompts/get' }, policy)
  for (const message of messages) {
    const content = asRecord(asRecord(message)?.['content'])
    if (content !== null && content['type'] === 'text' && typeof content['text'] === 'string') {
      observeInto(content, 'text', 'prompts/get', source, cordon)
    } else {
      cordon.markUnredacted()
    }
  }
  return value
}

/**
 * Observes one text field and writes the cleaned text back into it.
 *
 * When the source's view forbids substitution, the original stays and the
 * finding is said out loud through the journal — the channel the agent
 * cannot reach. There is no transcript footer on this transport: the gateway
 * never sees the model's answer, only the pipe.
 */
function observeInto(
  entry: Record<string, unknown>,
  key: string,
  tool: string,
  source: Source,
  cordon: Cordon,
): void {
  const envelope = cordon.observe(entry[key] as string, source)
  if (envelope.substitute) {
    entry[key] = envelope.text
  } else if (envelope.findings.length > 0) {
    cordon.notice(tool, `a hidden layer was found in the result of ${tool}; it was not substituted`, source)
  }
}

/**
 * The source's name: a link or a path from the call's arguments, and the
 * tool name when there are none. The same rule as in both hook adapters —
 * a tool name instead of a link would kill trustedSources entirely, because
 * the declared prefix is then compared against the word "Read".
 */
function sourceLabel(call: ToolCall): string {
  const args = Object.entries(call.args)
  for (const set of [URL_KEYS, PATH_KEYS]) {
    for (const [key, value] of args) {
      if (!set.has(fold(key))) continue
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return call.tool
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * The same check the hooks run, for the same reason: without writes
 * provenance is always empty, and from the outside that looks like a working
 * defence.
 */
function ensureUsableHome(home: string): void {
  const sessions = join(home, 'sessions')
  makeDirectory(sessions)
  accessSync(sessions, constants.W_OK)
}
