import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { Cordon } from '../../cordon.js'
import { sourceLabel } from '../../core/argument-keys.js'
import { makeDirectory } from '../../core/mkdir.js'
import { rewriteNotice } from '../../core/rewrite-notice.js'
import type { Source, ToolCall } from '../../core/types.js'
import type { Policy } from '../../policy/defaults.js'
import { homeProblem, projectDir } from '../../policy/home.js'
import { classifySource } from '../../provenance/trust.js'
import { APPROVAL_TTL_MS, ApprovalStore } from '../../session/approvals.js'
import { extractText, replaceText } from '../../output/tool-text.js'
import { sanitize } from '../../sanitize/index.js'
import { parseError, parseLine, pendingKey, toolError, type Message } from './jsonrpc.js'

export interface GatewayOptions {
  /** The upstream server command: `cordon mcp -- npx server-x` gives ['npx', 'server-x']. */
  command: string[]
  policy: Policy
  cordonHome: string
  /** Where the policy came from: a change there stops the gateway acting (see CordonOptions). */
  policyFile?: string
  /** Injectable for tests; the real process runs on stdin/stdout. */
  hostIn?: Readable
  hostOut?: Writable
  /** Extra environment for the upstream process. Tests steer the fake server through it. */
  env?: Record<string, string>
  /** Opt-in time to hold an exact call for owner approval; zero replies with a refusal. */
  approvalWaitMs?: number
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
  /** Set when the call ran with arguments Cordon cut: the model is told so with the result. */
  notice?: string
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
    const reviewTimers = new Map<string, { timer: NodeJS.Timeout; approvalId: string; requestId: string | number }>()
    let cancelWaiting: ((id: string, reason: string) => void) | null = null

    const retireIfLastWaiter = (id: string, reason: string): void => {
      if ([...reviewTimers.values()].some((held) => held.approvalId === id)) return
      cancelWaiting?.(id, reason)
    }

    // Every exit runs through here, exactly once. Killing the upstream on the
    // way out matters: a host that went away leaves no reader for the
    // upstream's answers, and a orphaned server keeps the machine's
    // resources and the session's state open.
    const finish = (code: number, reason?: string): void => {
      if (settled) return
      settled = true
      for (const { timer, approvalId } of reviewTimers.values()) {
        clearInterval(timer)
        try {
          cancelWaiting?.(approvalId, 'the MCP gateway stopped before the owner answered')
        } catch (error) {
          // The host has already lost this gateway. Never resume a held call;
          // report the failed cleanup on the loud channel.
          log(`could not retire held approval ${approvalId}: ${(error as Error).message}`)
        }
      }
      reviewTimers.clear()
      if (reason !== undefined) log(reason)
      if (upstream !== null && upstream.exitCode === null && !upstream.killed) upstream.kill()
      resolve(code)
    }

    // Session state is the journal and the memory. A gateway that cannot
    // write it is a proxy with dead provenance that looks alive — the same
    // state the hooks refuse to start in, and here refusing is cheap: the
    // host simply sees a server that failed to start.
    try {
      // A project's MCP configuration can set env for the server entry, and
      // with it CORDON_HOME: the same repository-supplied policy the hooks
      // refuse.
      const problem = homeProblem(options.cordonHome, projectDir())
      if (problem !== null) throw new Error(problem)
      ensureUsableHome(options.cordonHome)
    } catch (error) {
      finish(1, `the home directory is not usable: ${(error as Error).message}`)
      return
    }

    const approvalWaitMs = options.approvalWaitMs ?? 0
    if (!Number.isSafeInteger(approvalWaitMs) || approvalWaitMs < 0 || approvalWaitMs > APPROVAL_TTL_MS) {
      finish(1, 'approvalWaitMs must be an integer from 0 to the one-hour approval lifetime')
      return
    }

    let cordon: Cordon
    try {
      // A PID can be reused within an approval's lifetime. Each gateway run
      // needs a fresh identity so a later process cannot load its provenance
      // and spend an old exact-call approval under the same question.
      const sessionId =
        `mcp-${createHash('sha256').update(options.command.join(' '), 'utf8').digest('hex').slice(0, 12)}-${randomBytes(16).toString('hex')}`
      cordon = new Cordon({
        policy: options.policy,
        cordonHome: options.cordonHome,
        sessionId,
        ...(options.policyFile === undefined ? {} : { policyFile: options.policyFile }),
      })
    } catch (error) {
      finish(1, `the session state is broken: ${(error as Error).message}`)
      return
    }
    cancelWaiting = (id, reason) => cordon.cancelUnattendedApproval(id, reason)

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
      if (settled) return
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
        if (message.type === 'notification' && message.method === 'notifications/cancelled') {
          const requestId = asRecord(message.params)?.['requestId']
          if (typeof requestId === 'string' || typeof requestId === 'number') {
            const key = pendingKey(requestId)
            const held = reviewTimers.get(key)
            if (held !== undefined) {
              clearInterval(held.timer)
              reviewTimers.delete(key)
              retireIfLastWaiter(held.approvalId, 'the host cancelled its MCP request')
              return
            }
          }
        }
        // Host notifications and answers travel toward the server. Server
        // requests are refused below, so a host response cannot grant one.
        sendUpstream(message.value)
        return
      }

      if (message.method === 'tools/call') {
        gateCall(message, cordon, options.policy, pending, sendToHost, sendUpstream,
          approvalWaitMs === 0 ? undefined : (approvalId, reason) => {
            const key = pendingKey(message.id)
            if (reviewTimers.has(key)) throw new Error(`a second review is waiting under request ${key}`)
            const approvals = new ApprovalStore(options.cordonHome)
            const deadline = Date.now() + approvalWaitMs
            const timer = setInterval(() => {
              try {
                if (Date.now() >= deadline) {
                  clearInterval(timer)
                  reviewTimers.delete(key)
                  retireIfLastWaiter(approvalId, 'the owner did not approve before the wait ended')
                  sendToHost(toolError(message.id, `Cordon approval wait timed out for ${message.method}: ${reason}`))
                  return
                }
                if (!existsSync(approvals.approvedPath(approvalId))) return
                // The host may have timed out without cancelling the request.
                // A late approval can only tell the model to retry; it cannot
                // execute a side effect after the host stopped waiting. The
                // retry goes through the core again under its current context.
                // Identical in-flight calls share one question. Release all
                // their waiters together, so one host cancellation cannot
                // revoke a retry instruction already sent to another.
                for (const [waitingKey, held] of reviewTimers) {
                  if (held.approvalId !== approvalId) continue
                  clearInterval(held.timer)
                  reviewTimers.delete(waitingKey)
                  sendToHost(toolError(held.requestId,
                    `Cordon recorded owner approval ${approvalId} for the call that produced this result. ` +
                    'Retry exactly the same tool call with the same tool name and arguments JSON; ' +
                    'do not alter any argument. Cordon rechecks the retry before execution.'))
                }
              } catch (error) {
                // A broken approval check cannot forward the held call.
                finish(1, `approval wait failed: ${(error as Error).message}`)
              }
            }, Math.min(25, approvalWaitMs))
            reviewTimers.set(key, { timer, approvalId, requestId: message.id })
          })
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
      // readline can emit later lines from a chunk after finish() kills the
      // upstream. A buffered notification must not escape the stopped gate.
      if (settled) return
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

      if (message.type === 'request') {
        // A server can ask the host to sample or elicit model input. Forwarding
        // that request makes server-authored content an instruction before the
        // tool-result gate sees it. Ping is contentless and answered here.
        if (message.method === 'ping' && message.params === undefined &&
          message.value['jsonrpc'] === '2.0' &&
          Object.keys(message.value).every((key) => ['jsonrpc', 'id', 'method'].includes(key))) {
          sendUpstream({ jsonrpc: '2.0', id: message.id, result: {} })
        } else {
          sendUpstream({ jsonrpc: '2.0', id: message.id, error: {
            code: -32601, message: 'Cordon does not forward server-origin requests.',
          } })
          log('a server-origin request was refused before the host received it')
        }
        return
      }
      if (message.type === 'notification') {
        const observed = observeServerNotification(message.value, message.method, cordon, options.policy)
        if (observed === null) log('unsupported server notification was withheld')
        else sendToHost(observed)
        return
      }

      const entry = pending.get(pendingKey(message.id))
      pending.delete(pendingKey(message.id))
      if (entry === undefined) {
        // The untrusted server has no host waiter for this response. Passing
        // it through would expose content that never went through observation.
        // A duplicate response is also a protocol break, so stop loudly.
        finish(1, 'unsolicited upstream response without a matching host request')
        return
      }

      if (Object.hasOwn(message.value, 'error')) {
        const error = asRecord(message.value['error'])
        const tool = entry.call?.tool ?? entry.method
        const label = entry.call === undefined ? (entry.label ?? entry.method) : sourceLabel(entry.call)
        const source = classifySource({ kind: 'tool', label, tool }, options.policy)
        if (error !== null && typeof error['message'] === 'string') {
          observeInto(error, 'message', tool, source, cordon)
        } else {
          cordon.markUnredacted()
        }
        // JSON-RPC error data has no MCP text-block shape. The host may show
        // it to the model, so opaque data carries the same unredacted mark as
        // an image or an unknown tool-result block.
        if (error !== null && Object.hasOwn(error, 'data')) cordon.markUnredacted()
        sendToHost(message.value)
        return
      }

      if (entry.method === 'tools/list') {
        sendToHost(observeToolList(message.value, cordon, options.policy, options.command))
        return
      }
      if (entry.method === 'initialize') {
        sendToHost(observeInitialize(message.value, cordon, options.policy))
        return
      }
      if (entry.method === 'server/discover') {
        sendToHost(observeDiscover(message.value, cordon, options.policy))
        return
      }
      if (entry.method === 'resources/list' || entry.method === 'resources/templates/list' || entry.method === 'prompts/list') {
        sendToHost(observeCatalogList(message.value, entry.method, cordon, options.policy))
        return
      }
      if (entry.method === 'tools/call' && entry.call !== undefined) {
        const observed = observeToolResult(message.value, entry.call, cordon, options.policy)
        sendToHost(entry.notice === undefined ? observed : withNotice(observed, entry.notice))
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
      if (entry.method === 'completion/complete') {
        sendToHost(observeCompletion(message.value, cordon, options.policy))
        return
      }
      sendToHost(observeOtherResponse(message.value, entry.method, cordon, options.policy))
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
    hostLines.on('close', () => {
      // A closed host with a request still in flight has lost its answer.
      // Returning success would make a broken MCP exchange look complete.
      if (pending.size > 0 || reviewTimers.size > 0) {
        finish(1, 'host closed with an unanswered MCP request')
      } else {
        finish(0)
      }
    })

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
 * The gateway has no one to ask: MCP carries no way to put the question in
 * front of the human and resume. The core turns the interactive mode's
 * question into a refusal naming a one-time approval the owner gives with
 * `cordon approve`; the retried call then passes once. `ask` is still read
 * as a refusal here should one ever arrive.
 */
function gateCall(
  message: Extract<Message, { type: 'request' }>,
  cordon: Cordon,
  policy: Policy,
  pending: Map<string, Pending>,
  sendToHost: (message: Record<string, unknown>) => void,
  sendUpstream: (message: Record<string, unknown>) => void,
  waitForApproval?: (id: string, reason: string) => void,
): void {
  const params = asRecord(message.params)
  const name = typeof params?.['name'] === 'string' ? params['name'] : ''
  const call: ToolCall = { tool: name, args: asRecord(params?.['arguments']) ?? {} }

  const decision = cordon.gateUnattended(call)
  if (decision.kind === 'deny' || decision.kind === 'ask') {
    if (decision.kind === 'deny' && decision.approvalId !== undefined && waitForApproval !== undefined) {
      waitForApproval(decision.approvalId, decision.reason)
      return
    }
    sendToHost(toolError(message.id, `Cordon refused the call to ${name || '(no tool named)'}: ${decision.reason}`))
    return
  }

  if (decision.kind === 'rewrite') {
    pending.set(pendingKey(message.id), { method: message.method, call, notice: rewriteNotice(decision) })
    // The forwarded request is reserialized: the original line carries the
    // arguments the model wrote, and they are exactly what was cut.
    sendUpstream({ ...message.value, params: { ...params, arguments: decision.args } })
    return
  }
  pending.set(pendingKey(message.id), { method: message.method, call })
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
  command: readonly string[],
): Record<string, unknown> {
  const result = asRecord(value['result'])
  const listed = result?.['tools']
  const source = classifySource({ kind: 'mcp-description', label: 'tools/list' }, policy)
  if (result === null || !Array.isArray(listed) ||
    Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    Object.keys(result).some((key) => !TOOL_LIST_KEYS.has(key)) ||
    (result['resultType'] !== undefined && result['resultType'] !== 'complete') ||
    (result['nextCursor'] !== undefined && typeof result['nextCursor'] !== 'string') ||
    (result['ttlMs'] !== undefined && (!Number.isSafeInteger(result['ttlMs']) ||
      (result['ttlMs'] as number) < 0)) ||
    (result['cacheScope'] !== undefined && result['cacheScope'] !== 'public' &&
      result['cacheScope'] !== 'private') ||
    listed.some((tool) => !readableListedTool(tool))) {
    return withholdUnreadableResponse(value, 'tools/list', source, cordon)
  }
  if (result['_meta'] !== undefined) {
    const observed = observeReadableResult(result['_meta'], 'tools/list', source, cordon, [])
    if (observed === null) return withholdUnreadableResponse(value, 'tools/list', source, cordon)
    result['_meta'] = observed.value
  }

  // Pinned before cleaning: the raw description is what the pin is of. A
  // held tool leaves the list the host receives, so the model never reads
  // the changed text; the core refuses a call to it by name. A damaged pin
  // file throws here, and the gateway stops loudly.
  const named = listed
    .map((tool) => asRecord(tool))
    .filter((tool): tool is Record<string, unknown> => tool !== null && typeof tool['name'] === 'string')
    .map((tool) => ({ name: tool['name'] as string, description: tool['description'], inputSchema: tool['inputSchema'],
      title: tool['title'], annotations: tool['annotations'], outputSchema: tool['outputSchema'], icons: tool['icons'] }))
  const held = new Set(cordon.admitTools(command, named).map((tool) => tool.name))
  const tools = listed.filter((tool) => !held.has(String(asRecord(tool)?.['name'])))
  value = { ...value, result: { ...result, tools } }

  for (const tool of tools) {
    const entry = asRecord(tool)
    if (entry === null) continue
    const name = typeof entry['name'] === 'string' ? entry['name'] : ''
    const source = classifySource({ kind: 'mcp-description', label: name, tool: name }, policy)
    if (typeof entry['description'] === 'string') observeDescription(entry, 'description', name, source, cordon)
    if (typeof entry['title'] === 'string') observeDescription(entry, 'title', name, source, cordon)
    if (entry['icons'] !== undefined) {
      // Icon references are protocol identifiers. Rewriting them can change
      // the resource fetched by the host, so withhold when cleaning is needed.
      const text = JSON.stringify(entry['icons'])
      if (cordon.observe(text, source).text !== text) return withholdUnreadableResponse(value, 'tools/list', source, cordon)
    }
    const annotations = asRecord(entry['annotations'])
    if (annotations !== null && typeof annotations['title'] === 'string') {
      observeDescription(annotations, 'title', name, source, cordon)
    }
    // Property descriptions are read by the model as much as the tool's own,
    // and a scanner that looks only at the top level misses them: the
    // classic place to put the poisoned line once the top level is watched.
    const schema = asRecord(entry['inputSchema'])
    if (schema !== null && !observeSchema(schema, name, source, cordon, 0)) {
      return withholdUnreadableResponse(value, 'tools/list', source, cordon)
    }
    if (schema !== null) {
      // One provenance write per schema keeps wide but valid tool lists from
      // turning every structural key into a session-store write.
      const text = JSON.stringify(schema)
      if (cordon.observe(text, source).text !== text) return withholdUnreadableResponse(value, 'tools/list', source, cordon)
    }
    const outputSchema = asRecord(entry['outputSchema'])
    if (outputSchema !== null && !observeSchema(outputSchema, name, source, cordon, 0)) {
      return withholdUnreadableResponse(value, 'tools/list', source, cordon)
    }
    if (outputSchema !== null) {
      const text = JSON.stringify(outputSchema)
      if (cordon.observe(text, source).text !== text) return withholdUnreadableResponse(value, 'tools/list', source, cordon)
    }
  }
  return value
}

/** How deep a schema is walked. Deeper than any real schema, bounded against a hostile one. */
const MAX_SCHEMA_DEPTH = 16
const MAX_SCHEMA_NODES = 20_000
const SCHEMA_VALUE_KEYS = new Set(['default', 'const', 'enum', 'examples'])

function readableListedTool(value: unknown): boolean {
  const entry = asRecord(value)
  if (entry === null || typeof entry['name'] !== 'string' || entry['name'] === '' ||
    Object.keys(entry).some((key) => !TOOL_ENTRY_KEYS.has(key)) ||
    (entry['description'] !== undefined && typeof entry['description'] !== 'string') ||
    (entry['title'] !== undefined && typeof entry['title'] !== 'string') ||
    (entry['icons'] !== undefined && !readableIcons(entry['icons']))) return false
  const input = asRecord(entry['inputSchema'])
  if (input === null || !readableSchemaText(input, 0)) return false
  if (entry['outputSchema'] !== undefined) {
    const output = asRecord(entry['outputSchema'])
    if (output === null || !readableSchemaText(output, 0)) return false
  }
  if (entry['annotations'] !== undefined) {
    const annotations = asRecord(entry['annotations'])
    if (annotations === null || Object.entries(annotations).some(([key, value]) =>
      key === 'title' ? typeof value !== 'string' : !TOOL_ANNOTATION_HINTS.has(key) || typeof value !== 'boolean')) return false
  }
  return true
}

function readableIcons(value: unknown): boolean {
  return Array.isArray(value) && value.every((icon) => {
    const entry = asRecord(icon)
    return entry !== null && typeof entry['src'] === 'string' && entry['src'] !== '' &&
      Object.keys(entry).every((key) => ['src', 'mimeType', 'sizes', 'theme'].includes(key)) &&
      sanitize(entry['src']).clean === entry['src'] &&
      (entry['mimeType'] === undefined || (typeof entry['mimeType'] === 'string' &&
        sanitize(entry['mimeType']).clean === entry['mimeType'])) &&
      (entry['theme'] === undefined || entry['theme'] === 'light' || entry['theme'] === 'dark') &&
      (entry['sizes'] === undefined || (Array.isArray(entry['sizes']) && entry['sizes'].every((size) =>
        typeof size === 'string' && sanitize(size).clean === size)))
  })
}

function readableSchemaText(node: unknown, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return true
  if (Array.isArray(node)) return node.every((item) => readableSchemaText(item, depth + 1))
  const record = asRecord(node)
  if (record === null) return true
  return Object.entries(record).every(([key, value]) => {
    if ((key === 'description' || key === 'title') && typeof value !== 'string') return false
    return readableSchemaText(value, depth + 1)
  })
}

/**
 * Every `description` and `title` string inside a JSON Schema, at any depth
 * up to the bound. A schema deeper than the bound is withheld: marking the
 * session while forwarding unread instructions still gives them to the model.
 */
function observeSchema(
  node: Record<string, unknown>,
  tool: string,
  source: Source,
  cordon: Cordon,
  depth: number,
  budget = { nodes: 0 },
): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false
  if (++budget.nodes > MAX_SCHEMA_NODES) return false
  for (const key of Object.keys(node)) {
    if (sanitize(key).clean !== key) return false
    const value = node[key]
    if ((key === 'description' || key === 'title') && typeof value === 'string') {
      observeDescription(node, key, tool, source, cordon)
    } else if (SCHEMA_VALUE_KEYS.has(key)) {
      // Rewriting a default or an enum can make the advertised schema disagree
      // with what the server accepts. Withhold the list if cleaning is needed.
      if (!observeSchemaValue(value, depth + 1, budget)) return false
    } else if (typeof value === 'string') {
      if (sanitize(value).clean !== value) return false
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const child = asRecord(item)
        if (child !== null) {
          if (!observeSchema(child, tool, source, cordon, depth + 1, budget)) return false
        } else if (!observeSchemaValue(item, depth + 1, budget)) return false
      }
    } else {
      const child = asRecord(value)
      if (child !== null && !observeSchema(child, tool, source, cordon, depth + 1, budget)) return false
    }
  }
  return true
}

function observeSchemaValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): boolean {
  if (depth > MAX_SCHEMA_DEPTH || ++budget.nodes > MAX_SCHEMA_NODES) return false
  if (typeof value === 'string') return sanitize(value).clean === value
  if (Array.isArray(value)) return value.every((item) => observeSchemaValue(item, depth + 1, budget))
  const record = asRecord(value)
  if (record !== null) return Object.entries(record).every(([key, item]) =>
    sanitize(key).clean === key && observeSchemaValue(item, depth + 1, budget))
  return true
}

function observeDescription(entry: Record<string, unknown>, key: string, tool: string, source: Source, cordon: Cordon): void {
  const envelope = cordon.observe(entry[key] as string, source)
  if (envelope.substitute) {
    entry[key] = envelope.text
  } else if (envelope.findings.length > 0) {
    cordon.notice(tool, `a hidden layer was found in the description of ${tool}; it was not substituted`, source)
  }
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
/**
 * Appends Cordon's own note to a tool result, after observation: it is not
 * content from the server and is not read as such. An error response carries
 * no result to append to, and the model already hears that the call failed.
 */
function withNotice(value: Record<string, unknown>, notice: string): Record<string, unknown> {
  const result = asRecord(value['result'])
  if (result === null) return value
  const content = Array.isArray(result['content']) ? result['content'] : []
  return { ...value, result: { ...result, content: [...content, { type: 'text', text: notice }] } }
}

const TOOL_RESULT_KEYS = new Set(['resultType', 'content', 'structuredContent', 'isError', '_meta'])
const TOOL_LIST_KEYS = new Set(['resultType', 'tools', 'nextCursor', '_meta', 'ttlMs', 'cacheScope'])
const TOOL_ENTRY_KEYS = new Set(['name', 'description', 'inputSchema', 'title', 'annotations', 'outputSchema', 'icons'])
const TOOL_ANNOTATION_HINTS = new Set(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
const RESPONSE_KEYS = new Set(['jsonrpc', 'id', 'result'])
const INITIALIZE_KEYS = new Set(['protocolVersion', 'capabilities', 'serverInfo', 'instructions', '_meta'])
const DISCOVER_KEYS = new Set(['resultType', 'supportedVersions', 'capabilities', 'instructions', '_meta', 'ttlMs', 'cacheScope'])
const SERVER_LIST_NOTIFICATIONS = new Set([
  'notifications/tools/list_changed', 'notifications/prompts/list_changed',
  'notifications/resources/list_changed',
])
const LOG_LEVELS = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'])

function observeServerNotification(
  value: Record<string, unknown>,
  method: string,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> | null {
  if (value['jsonrpc'] !== '2.0' || Object.keys(value).some((key) =>
    !['jsonrpc', 'method', 'params'].includes(key))) return null
  if (SERVER_LIST_NOTIFICATIONS.has(method)) {
    const params = value['params']
    if (params !== undefined) {
      const record = asRecord(params)
      if (record === null || Object.keys(record).length > 0) return null
    }
    return { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
  }
  if (method !== 'notifications/message') return null
  const params = asRecord(value['params'])
  if (params === null || !LOG_LEVELS.has(String(params['level'])) ||
    !Object.hasOwn(params, 'data') ||
    Object.keys(params).some((key) => !['level', 'logger', 'data', '_meta'].includes(key)) ||
    (params['logger'] !== undefined && typeof params['logger'] !== 'string')) return null
  const source = classifySource({ kind: 'mcp-description', label: method }, policy)
  const observed = observeReadableResult(params, method, source, cordon, [])
  if (observed === null) return null
  // Arbitrary JSON logging data may carry text in property names, which the
  // generic text extractor treats as structure. The full serialized message
  // has to survive the sanitizer unchanged before the host sees those keys.
  const text = JSON.stringify(observed.value)
  if (cordon.observe(text, source).text !== text) return null
  return { jsonrpc: '2.0', method, params: observed.value }
}

/** The server can send model-facing instructions before the host lists any tools. */
function observeInitialize(
  value: Record<string, unknown>,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const source = classifySource({ kind: 'mcp-description', label: 'initialize' }, policy)
  const result = asRecord(value['result'])
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    result === null || Object.keys(result).some((key) => !INITIALIZE_KEYS.has(key)) ||
    typeof result['protocolVersion'] !== 'string' ||
    asRecord(result['capabilities']) === null ||
    asRecord(result['serverInfo']) === null ||
    (result['instructions'] !== undefined && typeof result['instructions'] !== 'string')) {
    return withholdUnreadableResponse(value, 'initialize', source, cordon)
  }
  const observed = observeReadableResult(result, 'initialize', source, cordon, [])
  if (observed === null) return withholdUnreadableResponse(value, 'initialize', source, cordon)
  return { jsonrpc: '2.0', id: value['id'], result: observed.value }
}

/** Modern MCP discovery carries the same model-facing instructions as initialize. */
function observeDiscover(
  value: Record<string, unknown>,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const source = classifySource({ kind: 'mcp-description', label: 'server/discover' }, policy)
  const result = asRecord(value['result'])
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    result === null || Object.keys(result).some((key) => !DISCOVER_KEYS.has(key)) ||
    result['resultType'] !== 'complete' ||
    !Array.isArray(result['supportedVersions']) ||
    result['supportedVersions'].length === 0 ||
    result['supportedVersions'].some((version: unknown) => typeof version !== 'string') ||
    asRecord(result['capabilities']) === null ||
    (result['instructions'] !== undefined && typeof result['instructions'] !== 'string') ||
    (result['_meta'] !== undefined && asRecord(result['_meta']) === null) ||
    (result['ttlMs'] !== undefined && (!Number.isSafeInteger(result['ttlMs']) ||
      (result['ttlMs'] as number) < 0)) ||
    (result['cacheScope'] !== undefined && result['cacheScope'] !== 'public' &&
      result['cacheScope'] !== 'private')) {
    return withholdUnreadableResponse(value, 'server/discover', source, cordon)
  }
  const observed = observeReadableResult(result, 'server/discover', source, cordon, [])
  if (observed === null) return withholdUnreadableResponse(value, 'server/discover', source, cordon)
  return { jsonrpc: '2.0', id: value['id'], result: observed.value }
}

/** A completion value is server-authored text that can be placed into the model's next call. */
function observeCompletion(
  value: Record<string, unknown>,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const method = 'completion/complete'
  const source = classifySource({ kind: 'tool', label: method, tool: method }, policy)
  const result = asRecord(value['result'])
  const completion = asRecord(result?.['completion'])
  const values = completion?.['values']
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    result === null || Object.keys(result).some((key) => !['completion', '_meta'].includes(key)) ||
    completion === null || Object.keys(completion).some((key) => !['values', 'total', 'hasMore'].includes(key)) ||
    !Array.isArray(values) || values.length > 100 ||
    values.some((item: unknown) => typeof item !== 'string') ||
    (completion['total'] !== undefined && (!Number.isSafeInteger(completion['total']) ||
      (completion['total'] as number) < 0)) ||
    (completion['hasMore'] !== undefined && typeof completion['hasMore'] !== 'boolean') ||
    (result['_meta'] !== undefined && asRecord(result['_meta']) === null)) {
    return withholdUnreadableResponse(value, method, source, cordon)
  }
  for (const item of values) {
    if (cordon.observe(item as string, source).text !== item) {
      return withholdUnreadableResponse(value, method, source, cordon)
    }
  }
  if (result['_meta'] !== undefined) {
    const observed = observeReadableResult(result['_meta'], method, source, cordon, [])
    if (observed === null || observed.value !== result['_meta']) {
      return withholdUnreadableResponse(value, method, source, cordon)
    }
  }
  const serialized = JSON.stringify(result)
  if (cordon.observe(serialized, source).text !== serialized) {
    return withholdUnreadableResponse(value, method, source, cordon)
  }
  return value
}

/** Unknown methods still return server text to the host; no response may bypass observation. */
function observeOtherResponse(
  value: Record<string, unknown>,
  method: string,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const source = classifySource({ kind: 'tool', label: method, tool: method }, policy)
  const result = asRecord(value['result'])
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) || result === null) {
    return withholdUnreadableResponse(value, method, source, cordon)
  }
  if (Object.keys(result).length === 0) return value
  const observed = observeReadableResult(result, method, source, cordon, [])
  if (observed === null || observed.value !== result) {
    return withholdUnreadableResponse(value, method, source, cordon)
  }
  const serialized = JSON.stringify(result)
  if (cordon.observe(serialized, source).text !== serialized) {
    return withholdUnreadableResponse(value, method, source, cordon)
  }
  return value
}

function observeToolResult(
  value: Record<string, unknown>,
  call: ToolCall,
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const source = classifySource({ kind: 'tool', label: sourceLabel(call), tool: call.tool }, policy)
  const result = asRecord(value['result'])
  if (result === null) return withholdUnreadableResult(value, call.tool, source, cordon)
  const texts: string[] = []
  const content = result['content']
  // A CallToolResult requires `content`. A host may expose extra result fields
  // to the model, and we have no safe role for a server-invented field.
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    !Array.isArray(content) ||
    Object.keys(result).some((key) => !TOOL_RESULT_KEYS.has(key)) ||
    (result['isError'] !== undefined && typeof result['isError'] !== 'boolean') ||
    (result['resultType'] !== undefined && result['resultType'] !== 'complete')) {
    return withholdUnreadableResult(value, call.tool, source, cordon)
  }

  for (const [index, block] of content.entries()) {
    const entry = asRecord(block)
    if (entry !== null && entry['type'] === 'text' && typeof entry['text'] === 'string') {
      // The server can append fields beside `text`; a host may show them too.
      const observed = observeReadableResult(entry, call.tool, source, cordon, texts)
      if (observed === null) return withholdUnreadableResult(value, call.tool, source, cordon)
      content[index] = observed.value
    } else {
      cordon.markUnredacted()
    }
  }

  // MCP structuredContent and _meta may be sent beside an inert content block.
  // The host can surface either to the model; passing them through here left
  // unobserved instructions in the same tool result on the gateway path.
  for (const field of ['structuredContent', '_meta'] as const) {
    const structured = result[field]
    if (structured === undefined) continue
    const observed = observeReadableResult(structured, call.tool, source, cordon, texts)
    if (observed === null) return withholdUnreadableResult(value, call.tool, source, cordon)
    result[field] = observed.value
  }
  cordon.recordLookup(call, texts)
  return value
}

function observeReadableResult(
  value: unknown,
  tool: string,
  source: Source,
  cordon: Cordon,
  texts: string[],
  allowUnseen = false,
): { value: unknown } | null {
  // An MCP server controls tool names. `Write` is textless in Claude Code,
  // but a server with that name can still return arbitrary readable data.
  const extracted = extractText('', value)
  if (!extracted.known || (extracted.unseen && !allowUnseen)) return null
  if (extracted.unseen) cordon.markUnredacted()
  let changed = false
  let substitutable = true
  const cleaned = extracted.parts.map((part) => {
    const envelope = cordon.observe(part.text, source, part.content ? 'content' : 'label')
    if (envelope.text !== part.text) changed = true
    if (!envelope.substitute) substitutable = false
    if (part.content) texts.push(envelope.text)
    return envelope.text
  })
  cordon.observeLinks(extracted.links, source)
  if (!changed) return { value }
  if (!substitutable) return null
  const next = replaceText('', value, cleaned)
  return next === value ? null : { value: next }
}

function withholdUnreadableResult(
  value: Record<string, unknown>,
  tool: string,
  source: Source,
  cordon: Cordon,
): Record<string, unknown> {
  cordon.markUnredacted()
  cordon.notice(tool, `output of ${tool} could not be scanned and was withheld`, source)
  return { jsonrpc: '2.0', id: value['id'], result: { isError: true,
    content: [{ type: 'text', text: 'Cordon withheld tool output because it could not be scanned.' }] } }
}

function withholdUnreadableResponse(
  value: Record<string, unknown>,
  method: string,
  source: Source,
  cordon: Cordon,
): Record<string, unknown> {
  cordon.markUnredacted()
  cordon.notice(method, `output of ${method} could not be scanned and was withheld`, source)
  // resources/read and prompts/get have no CallToolResult.isError. A JSON-RPC
  // error is the only protocol-shaped way to keep the unseen bytes from the host.
  return { jsonrpc: '2.0', id: value['id'], error: {
    code: -32000, message: `Cordon withheld ${method} output because it could not be scanned.`,
  } }
}

/** Discovery descriptions are server-authored instructions before any read. */
function observeCatalogList(
  value: Record<string, unknown>,
  method: 'resources/list' | 'resources/templates/list' | 'prompts/list',
  cordon: Cordon,
  policy: Policy,
): Record<string, unknown> {
  const source = classifySource({ kind: 'mcp-description', label: method }, policy)
  const result = asRecord(value['result'])
  const key = method === 'prompts/list' ? 'prompts'
    : method === 'resources/templates/list' ? 'resourceTemplates' : 'resources'
  if (Object.keys(value).some((field) => !RESPONSE_KEYS.has(field)) ||
    result === null || !Array.isArray(result[key])) {
    return withholdUnreadableResponse(value, method, source, cordon)
  }
  const observed = observeReadableResult(result, method, source, cordon, [])
  if (observed === null) return withholdUnreadableResponse(value, method, source, cordon)
  return { jsonrpc: '2.0', id: value['id'], result: observed.value }
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
  const source = classifySource({ kind: 'tool', label: pending.label ?? 'resources/read', tool: 'resources/read' }, policy)
  const result = asRecord(value['result'])
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    result === null || !Array.isArray(result['contents'])) {
    return withholdUnreadableResponse(value, 'resources/read', source, cordon)
  }
  // The returned URI is server-controlled. The requested URI is the only
  // source identity the owner could have declared trustworthy before reading.
  const observed = observeReadableResult(result, 'resources/read', source, cordon, [], true)
  if (observed === null) return withholdUnreadableResponse(value, 'resources/read', source, cordon)
  return { jsonrpc: '2.0', id: value['id'], result: observed.value }
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
  const label = pending.label ?? 'prompts/get'
  const source = classifySource({ kind: 'tool', label, tool: 'prompts/get' }, policy)
  const result = asRecord(value['result'])
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)) ||
    result === null || !Array.isArray(result['messages'])) {
    return withholdUnreadableResponse(value, 'prompts/get', source, cordon)
  }
  const observed = observeReadableResult(result, 'prompts/get', source, cordon, [], true)
  if (observed === null) return withholdUnreadableResponse(value, 'prompts/get', source, cordon)
  return { jsonrpc: '2.0', id: value['id'], result: observed.value }
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
