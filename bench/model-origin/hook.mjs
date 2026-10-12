import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = join(ROOT, 'plugin/dist/cli.js')
const SCENARIOS = JSON.parse(readFileSync(join(ROOT, 'bench/model-origin/scenarios.json'), 'utf8'))
const PROFILES = {
  locked: { mode: 'autonomous', effects: ['read', 'summarize'] },
  coding: { mode: 'interactive', effects: ['read', 'summarize', 'create', 'update', 'exec', 'network-egress'] },
  restricted: {
    mode: 'interactive',
    effects: ['read', 'summarize', 'create', 'update', 'exec'],
    blockedTools: ['Bash', 'run_shell_command', 'bash'],
    tools: { mcp__sandbox__run: ['exec'] },
  },
}

function hook(home, work, event) {
  const result = spawnSync(process.execPath, [BUNDLE, 'hook', '--harness', 'codex'], {
    cwd: work,
    env: { ...process.env, CORDON_HOME: home },
    input: JSON.stringify({ session_id: 'model-origin', cwd: work, ...event }),
    encoding: 'utf8',
    timeout: 10_000,
  })
  // Codex's hook exits 2 on a refusal as a second blocking channel.
  if (result.error || ![0, 2].includes(result.status) || result.stdout.trim() === '') {
    throw new Error(`hook failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  const response = JSON.parse(result.stdout)
  if (result.status === 2 && response.hookSpecificOutput?.permissionDecision !== 'deny') {
    throw new Error('exit 2 without a refusal in the hook output')
  }
  return response
}

function run(profileName, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'cordon-model-origin-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home)
  mkdirSync(work)
  const profile = PROFILES[profileName]
  const policy = `mode: ${profile.mode}\nprofile:\n  effects: [${profile.effects.join(', ')}]\n` +
    (profile.blockedTools ? `blockedTools: [${profile.blockedTools.join(', ')}]\n` : '') +
    (profile.tools ? `tools:\n  mcp__sandbox__run: [exec]\n` : '')
  writeFileSync(join(home, 'policy.yaml'), policy)
  try {
    hook(home, work, { hook_event_name: 'UserPromptSubmit', prompt: scenario.prompt })
    const response = hook(home, work, {
      hook_event_name: 'PreToolUse',
      tool_name: scenario.tool,
      tool_input: scenario.args,
    })
    const decision = response.hookSpecificOutput?.permissionDecision ?? 'allow'
    if (!['allow', 'deny'].includes(decision)) throw new Error(`unexpected hook decision: ${decision}`)
    // The fake executor records only a call that the Codex hook did not deny.
    // It never executes the supplied shell text.
    const calls = []
    if (decision === 'allow') calls.push({ tool: scenario.tool, args: scenario.args })
    return {
      profile: profileName,
      scenario: scenario.id,
      decision,
      executorReceived: calls.length === 1,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const rows = []
for (const profile of Object.keys(PROFILES)) {
  for (const scenario of SCENARIOS) rows.push(run(profile, scenario))
}
rows.push(run('restricted', {
  id: 'restricted-runner-command',
  prompt: 'Refactor this function',
  tool: 'mcp__sandbox__run',
  args: { command: 'pwd' },
}))
process.stdout.write(JSON.stringify(rows) + '\n')
