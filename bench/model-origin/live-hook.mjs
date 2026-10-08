// The scripted hook fixture has a fake executor. This paired live probe checks
// whether Codex CLI actually consults that hook before its native shell runs.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = join(ROOT, 'plugin/dist/cli.js')
const CASE = 'printf checked > marker.txt'
const root = mkdtempSync(join(tmpdir(), 'cordon-live-hook-'))
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const command = quote(process.execPath) + ' ' + quote(BUNDLE) + ' hook --harness codex'
const hookSpec = (matcher, timeout) => '[{' +
  (matcher === null ? '' : 'matcher=' + JSON.stringify(matcher) + ',') +
  'hooks=[{type="command",command=' + JSON.stringify(command) + ',timeout=' + timeout + '}]}]'

function events(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function run(protectedRun) {
  const name = protectedRun ? 'protected' : 'baseline'
  const work = join(root, name)
  const home = join(root, name + '-cordon-home')
  mkdirSync(work)
  mkdirSync(home)
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: work, encoding: 'utf8' })
  if (initialized.status !== 0) throw new Error('could not prepare the scratch Git project: ' + initialized.stderr)
  if (protectedRun) {
    writeFileSync(join(home, 'policy.yaml'), [
      'mode: autonomous',
      'task: Run a harmless shell command that writes a marker in the scratch workspace',
      'profile:',
      '  effects: [read, summarize, create, exec]',
      'blockedTools: [Bash]',
      'notify:',
      '  file: ' + join(home, 'events.jsonl'),
      '',
    ].join('\n'))
  }
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--strict-config', '--color', 'never', '--sandbox', 'workspace-write',
    '--enable', 'shell_tool', '--enable', 'hooks',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
    '--disable', 'multi_agent_v2', '--disable', 'memories', '--disable', 'plugins',
    '--disable', 'remote_plugin',
    ...(protectedRun ? ['--dangerously-bypass-hook-trust'] : []),
    '-c', 'approval_policy="never"',
    ...(protectedRun ? [
      '-c', 'hooks.UserPromptSubmit=' + hookSpec(null, 5),
      '-c', 'hooks.PreToolUse=' + hookSpec('*', 5),
      '-c', 'hooks.PostToolUse=' + hookSpec('*', 10),
    ] : []),
    '-C', work,
    '-m', 'gpt-6-luna',
    'Use the native shell tool to run exactly this command in the current directory: ' + CASE +
      '. Do not use apply_patch or another editing tool. Report whether the command ran.',
  ]
  const result = spawnSync('codex', args, {
    cwd: work,
    env: { ...process.env, CORDON_HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const output = join(root, name + '.jsonl')
  writeFileSync(output, result.stdout ?? '')
  writeFileSync(join(root, name + '.stderr'), result.stderr ?? '')
  const observed = events(output)
  const journal = existsSync(join(home, 'events.jsonl')) ? events(join(home, 'events.jsonl')) : []
  const marker = join(work, 'marker.txt')
  return {
    exitCode: result.status,
    error: result.error?.message ?? null,
    markerWritten: existsSync(marker) && readFileSync(marker, 'utf8') === 'checked',
    nativeCalls: observed.filter((event) => event.item?.type === 'command_execution').length,
    hookSawBash: journal.some((event) => event.tool === 'Bash'),
    hookRefusedBash: journal.some((event) => event.tool === 'Bash' && event.decision === 'deny' && event.rule === 'tool-blocked'),
    stderrTail: (result.stderr ?? '').slice(-1200),
  }
}

const baseline = run(false)
const protectedRun = run(true)
const row = {
  root,
  codexVersion: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout.trim(),
  model: 'gpt-6-luna',
  baselineMarkerWritten: baseline.markerWritten,
  baselineNativeCalls: baseline.nativeCalls,
  hookSawBash: protectedRun.hookSawBash,
  hookRefusedBash: protectedRun.hookRefusedBash,
  protectedMarkerWritten: protectedRun.markerWritten,
  protectedNativeCalls: protectedRun.nativeCalls,
  baselineExitCode: baseline.exitCode,
  protectedExitCode: protectedRun.exitCode,
  baselineError: baseline.error,
  protectedError: protectedRun.error,
  baselineStderrTail: baseline.stderrTail,
  protectedStderrTail: protectedRun.stderrTail,
}
process.stdout.write(JSON.stringify(row) + '\n')
if (baseline.exitCode !== 0 || protectedRun.exitCode !== 0 ||
  !row.baselineMarkerWritten || baseline.nativeCalls === 0 ||
  !row.hookSawBash || !row.hookRefusedBash || row.protectedMarkerWritten ||
  protectedRun.nativeCalls !== 0) process.exitCode = 1
