// Probe one native Codex input call with a local responder and no account token.
// Default mode cannot present the question, but the hook must see the call first.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = join(dirname(fileURLToPath(import.meta.url)), '../..')
const root = mkdtempSync(join(tmpdir(), 'cordon-native-input-'))
const bundle = join(project, 'plugin/dist/cli.js')
const tap = join(project, 'bench/model-origin/hook-tap.mjs')
const model = 'cordon-poison-qwen:1.5b'
const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' })
if (codexVersion.status !== 0) throw new Error('installed Codex CLI is required')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const toml = (value) => JSON.stringify(value)
const parseLines = (raw) => raw.split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})

function modelOutput(index) {
  if (index === 1) return {
    id: 'call_input', type: 'function_call', name: 'request_user_input', call_id: 'call_input',
    arguments: JSON.stringify({ questions: [{
      header: 'Canary', id: 'canary', question: 'Synthetic canary: continue?',
      options: [
        { label: 'Continue', description: 'Record the local tool path.' },
        { label: 'Stop', description: 'End the probe.' },
      ],
    }] }),
  }
  return { id: 'done', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Probe complete.', annotations: [] }] }
}

function sendResponse(response, index, output) {
  const answer = { id: 'resp_' + index, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'completed', model, output: [output],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  let sequenceNumber = 0
  const send = (type, fields) => response.write('event: ' + type + '\ndata: ' +
    JSON.stringify({ type, sequence_number: sequenceNumber++, ...fields }) + '\n\n')
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  send('response.created', { response: { ...answer, status: 'in_progress', output: [] } })
  send('response.output_item.added', { output_index: 0, item: { ...output, status: 'in_progress' } })
  if (output.type === 'message') {
    send('response.content_part.added', { item_id: output.id, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } })
    send('response.output_text.delta', { item_id: output.id, output_index: 0, content_index: 0,
      delta: output.content[0].text })
    send('response.output_text.done', { item_id: output.id, output_index: 0, content_index: 0,
      text: output.content[0].text })
    send('response.content_part.done', { item_id: output.id, output_index: 0, content_index: 0,
      part: output.content[0] })
  }
  send('response.output_item.done', { output_index: 0, item: output })
  send('response.completed', { response: answer })
  response.end('data: [DONE]\n\n')
}

async function run(arm) {
  const protectedArm = arm === 'protected'
  const planConfigArm = arm === 'plan-config'
  const work = join(root, arm, 'work')
  const home = join(root, arm, 'codex-home')
  const cordonHome = join(root, arm, 'cordon-home')
  const tapLog = join(cordonHome, 'hook-tap.jsonl')
  for (const path of [work, home, cordonHome]) mkdirSync(path, { recursive: true, mode: 0o700 })
  if (protectedArm) writeFileSync(join(cordonHome, 'policy.yaml'), [
    'mode: autonomous',
    'task: Answer a synthetic canary question',
    'profile:',
    '  effects: [read]',
    'allowedTools: []',
    'notify:',
    '  file: ' + join(cordonHome, 'events.jsonl'),
    '',
  ].join('\n'))

  let modelCalls = 0
  let declaredInput = false
  let returned = null
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of request) body += part
    const parsed = JSON.parse(body)
    modelCalls++
    if (modelCalls === 1) declaredInput = (parsed.tools ?? []).some((tool) =>
      tool.name === 'request_user_input')
    if (modelCalls === 2) returned = (parsed.input ?? []).find((item) =>
      item.type === 'function_call_output' && item.call_id === 'call_input')?.output ?? null
    sendResponse(response, modelCalls, modelOutput(modelCalls))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('local responder address missing')
  const hookCommand = [process.execPath, tap, bundle].map((part) =>
    "'" + part.replaceAll("'", "'\\''") + "'").join(' ')
  const hook = '[{matcher="*",hooks=[{type="command",command=' + toml(hookCommand) + ',timeout=5}]}]'
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--strict-config', '--color', 'never', '--sandbox', 'read-only',
    '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--disable', 'goals', '--disable', 'memories', '--disable', 'plugins',
    '--disable', 'remote_plugin',
    ...(protectedArm ? [
      '--enable', 'hooks', '--dangerously-bypass-hook-trust',
      '-c', 'hooks.UserPromptSubmit=' + hook,
      '-c', 'hooks.PreToolUse=' + hook,
      '-c', 'hooks.PostToolUse=' + hook,
    ] : ['--disable', 'hooks']),
    ...(planConfigArm ? ['-c', 'collaboration_mode="plan"'] : []),
    '-c', 'approval_policy="never"',
    '-c', 'model_provider="probe"',
    '-c', 'model_providers.probe.name="Local input probe"',
    '-c', 'model_providers.probe.base_url=' + toml('http://127.0.0.1:' + address.port + '/v1'),
    '-c', 'model_providers.probe.env_key="CORDON_PROBE_DUMMY"',
    '-c', 'model_providers.probe.requires_openai_auth=false',
    '-c', 'model_providers.probe.supports_websockets=false',
    '-C', work, '-m', model, 'Use the synthetic input tool once.',
  ]
  const environment = { ...process.env, CODEX_HOME: home, CORDON_HOME: cordonHome,
    CORDON_HOOK_TAP_LOG: tapLog, CORDON_PROBE_DUMMY: 'local-only' }
  delete environment.OPENAI_API_KEY
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let exitCode = null
  try {
    const child = spawn('codex', args, { cwd: work, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15_000)
    try { exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }) } finally { clearTimeout(timer) }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  const tapRaw = existsSync(tapLog) ? readFileSync(tapLog, 'utf8') : ''
  const journalRaw = existsSync(join(cordonHome, 'events.jsonl'))
    ? readFileSync(join(cordonHome, 'events.jsonl'), 'utf8') : ''
  const tapEvents = parseLines(tapRaw)
  const journal = parseLines(journalRaw)
  return {
    arm, exitCode, timedOut, modelCalls, declaredInput, returned,
    preToolHookSeen: tapEvents.some((event) => event.kind === 'PreToolUse' &&
      event.tool === 'request_user_input'),
    policyDenied: journal.some((event) => event.tool === 'request_user_input' &&
      event.decision === 'deny' && event.rule === 'tool-not-allowed'),
    configRejected: stderr.includes('unknown configuration field `collaboration_mode`'),
    rawHashes: { stdout: hash(stdout), stderr: hash(stderr), tap: hash(tapRaw), journal: hash(journalRaw) },
  }
}

const baseline = await run('baseline')
const protectedRun = await run('protected')
const planConfig = await run('plan-config')
process.stdout.write(JSON.stringify({ codexVersion: codexVersion.stdout.trim(), modelInvoked: false,
  root, baseline, protected: protectedRun, planConfig }) + '\n')
if (baseline.exitCode !== 0 || baseline.timedOut || baseline.modelCalls !== 2 ||
  !baseline.declaredInput || baseline.returned !== 'request_user_input is unavailable in Default mode' ||
  baseline.preToolHookSeen || protectedRun.exitCode !== 0 || protectedRun.timedOut ||
  protectedRun.modelCalls !== 2 || !protectedRun.declaredInput ||
  !protectedRun.preToolHookSeen || !protectedRun.policyDenied || planConfig.exitCode !== 1 ||
  planConfig.timedOut || planConfig.modelCalls !== 0 || !planConfig.configRejected ||
  planConfig.preToolHookSeen) process.exitCode = 1
