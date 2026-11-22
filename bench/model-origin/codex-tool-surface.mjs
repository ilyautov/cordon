// Capture the first model request from the installed Codex CLI, then stop.
// The local responder never returns a model output or executes a tool call.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declaredToolSurface, requestToolShape } from './tool-inventory.mjs'

const root = mkdtempSync(join(tmpdir(), 'cordon-codex-tool-surface-'))
const discoveryServer = join(dirname(fileURLToPath(import.meta.url)), 'tool-surface-server.mjs')
const modelId = 'cordon-poison-qwen:1.5b'
const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
if (version.status !== 0) throw new Error('installed Codex CLI is required')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const toml = (value) => JSON.stringify(value)

async function capture(arm) {
  const home = join(root, arm, 'codex-home')
  const work = join(root, arm, 'work')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(work, { recursive: true, mode: 0o700 })
  let sawRequest = false
  let requestShape = null
  let toolSurface = null
  let toolDeclarationSha256 = null
  let requestError = null
  let child
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    try {
      for await (const chunk of request) {
        body += chunk.toString('utf8')
        if (body.length > 2_000_000) throw new Error('model request exceeded capture limit')
      }
      const parsed = JSON.parse(body)
      requestShape = requestToolShape(parsed)
      toolSurface = declaredToolSurface(parsed)
      toolDeclarationSha256 = Array.isArray(parsed.tools) ? hash(JSON.stringify(parsed.tools)) : null
      sawRequest = true
    } catch (error) {
      requestError = error.message
    }
    // No model response is supplied, so no model-selected tool can execute.
    response.writeHead(503, { 'content-type': 'text/plain' }).end('Capture complete')
    if (child !== undefined) setTimeout(() => child.kill('SIGTERM'), 50)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('capture listener address missing')
  const featureArgs = arm === 'restricted' ? [
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--disable', 'goals',
  ] : []
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--strict-config', '--color', 'never', '--sandbox', arm === 'writable' ? 'workspace-write' : 'read-only',
    '--disable', 'hooks', '--disable', 'memories', '--disable', 'plugins',
    '--disable', 'remote_plugin', ...featureArgs,
    '-c', 'approval_policy="never"',
    '-c', 'model_provider="capture"',
    '-c', 'model_providers.capture.name="Local tool-surface capture"',
    '-c', 'model_providers.capture.base_url=' + toml('http://127.0.0.1:' + address.port + '/v1'),
    '-c', 'model_providers.capture.env_key="CORDON_CAPTURE_DUMMY"',
    '-c', 'model_providers.capture.requires_openai_auth=false',
    '-c', 'model_providers.capture.supports_websockets=false',
    '-c', 'mcp_servers.probe.command=' + toml(process.execPath),
    '-c', 'mcp_servers.probe.args=' + toml([discoveryServer]),
    '-c', 'mcp_servers.probe.required=true',
    '-C', work, '-m', modelId, 'Return the word ready.',
  ]
  const environment = { ...process.env, CODEX_HOME: home, CORDON_CAPTURE_DUMMY: 'local-only' }
  delete environment.OPENAI_API_KEY
  let stdout = ''
  let stderr = ''
  let exitCode = null
  let timedOut = false
  try {
    child = spawn('codex', args, { cwd: work, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 30_000)
    try { exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }) } finally { clearTimeout(timeout) }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  return {
    arm, sawRequest, requestError, requestShape, toolSurface, toolDeclarationSha256,
    codexExitCode: exitCode, codexStopSignal: child.signalCode, timedOut,
    probeDeclared: toolSurface?.some((tool) => tool.name === 'mcp__probe' &&
      tool.members.includes('canary_lookup')) ?? false,
    workFiles: readdirSync(work),
    stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
    // This guard asserts the model did not receive a usable response and
    // Codex therefore recorded no completed action.
    completedToolItems: stdout.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    }).filter((event) => event.type === 'item.completed' &&
      ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item?.type)).length,
  }
}

const arms = []
for (const arm of ['standard', 'writable', 'restricted']) arms.push(await capture(arm))
process.stdout.write(JSON.stringify({ root, codexVersion: version.stdout.trim(), modelId, arms }) + '\n')
if (arms.some((arm) => !arm.sawRequest || arm.requestError !== null ||
  arm.requestShape?.toolsKind !== 'array' || arm.requestShape.toolCount < 1 ||
  !arm.probeDeclared || arm.workFiles.length !== 0 ||
  arm.timedOut || arm.completedToolItems !== 0)) process.exitCode = 1
