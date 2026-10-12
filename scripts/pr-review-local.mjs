// Run the review with only the fixed PR MCP tools and Cordon hooks.
// The local agent gets no shell, token environment variable, or approval directory.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedReviewPrompt } from '../dist/pr-workflow/review.js'
import { readReviewEvents, validateTarget } from '../dist/pr-workflow/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [repo, numberText, headSha, ledger] = process.argv.slice(2)
const target = { repo: repo ?? '', number: Number(numberText), headSha: headSha ?? '' }
validateTarget(target)
if (!ledger) throw new Error('usage: node scripts/pr-review-local.mjs <repo> <number> <sha> <ledger>')

const temp = mkdtempSync(join(tmpdir(), 'cordon-pr-local-'))
const work = join(temp, 'work')
const cordonHome = join(temp, 'cordon-home')
const hookLog = join(temp, 'hook-events.jsonl')
mkdirSync(work, { mode: 0o700 })
mkdirSync(cordonHome, { mode: 0o700 })
writeFileSync(join(cordonHome, 'policy.yaml'), [
  'mode: autonomous',
  `task: Review PR number ${target.number} at the pinned head and report findings`,
  'profile:',
  '  effects: [read, summarize, update]',
  'tools:',
  '  mcp__pr__read_pr: [read]',
  '  mcp__pr__read_diff: [read]',
  '  mcp__pr__propose_merge: [update]',
  'toolsReturn:',
  '  mcp__pr__read_pr: source',
  '  mcp__pr__read_diff: source',
  'arguments:',
  '  mcp__pr__propose_merge:',
  '    pr: destination',
  'destinations:',
  `  - "${target.number}"`,
  'notify:',
  `  file: ${join(cordonHome, 'events.jsonl')}`,
  '',
].join('\n'), { mode: 0o600 })

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const hookCommand = quote(process.execPath) + ' ' + quote(join(root, 'scripts/pr-review-hook.mjs'))
const hook = (matcher) => '[{' + (matcher === null ? '' : 'matcher=' + JSON.stringify(matcher) + ',') +
  'hooks=[{type="command",command=' + JSON.stringify(hookCommand) + ',timeout=5}]}]'
const toml = (value) => JSON.stringify(value)
const args = [
  'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
  '--strict-config', '--color', 'never', '--sandbox', 'read-only',
  '--enable', 'hooks', '--dangerously-bypass-hook-trust',
  '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'browser_use',
  '--disable', 'computer_use', '--disable', 'multi_agent_v2', '--disable', 'memories',
  '--disable', 'plugins', '--disable', 'remote_plugin',
  '-c', 'hooks.UserPromptSubmit=' + hook(null),
  '-c', 'hooks.PreToolUse=' + hook('*'),
  '-c', 'hooks.PostToolUse=' + hook('*'),
  '-c', 'approval_policy="never"',
  '-c', 'web_search="disabled"',
  '-c', 'mcp_servers.pr.command=' + toml(process.execPath),
  '-c', 'mcp_servers.pr.args=' + toml([join(root, 'dist/pr-workflow/cli.js'),
    'serve', repo, String(target.number), headSha, ledger]),
  '-c', 'mcp_servers.pr.required=true',
  '-c', 'mcp_servers.pr.tools.read_pr.approval_mode="approve"',
  '-c', 'mcp_servers.pr.tools.read_diff.approval_mode="approve"',
  '-c', 'mcp_servers.pr.tools.propose_merge.approval_mode="approve"',
  '-C', work, fixedReviewPrompt(target.number),
]
const agentEnv = { ...process.env, CORDON_HOME: cordonHome, CORDON_PR_HOOK_LOG: hookLog }
delete agentEnv.GH_TOKEN
delete agentEnv.GITHUB_TOKEN
const result = spawnSync('codex', args, {
  cwd: work, env: agentEnv, encoding: 'utf8',
  timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
})
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
process.stderr.write(`\nReview evidence: ${ledger}\nHook evidence: ${hookLog}\n`)
if (result.error) throw result.error
const events = (result.stdout ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const calls = events.filter((row) => row.type === 'item.completed' && row.item?.type === 'mcp_tool_call')
const hooks = readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const readDiff = calls.some((row) => row.item.tool === 'read_diff' && row.item.status === 'completed')
const diffEvidence = readReviewEvents(ledger).some((event) => event.kind === 'diff-read' &&
  event.repo === repo && event.number === target.number && event.headSha === headSha)
const hooksCovered = hooks.some((row) => row.kind === 'UserPromptSubmit' && row.status === 0) &&
  calls.every((call) => hooks.some((row) => row.kind === 'PreToolUse' && row.status === 0 &&
    row.tool === `mcp__pr__${call.item.tool}`) && hooks.some((row) => row.kind === 'PostToolUse' &&
    row.tool === `mcp__pr__${call.item.tool}` && (row.status === 0 ||
      (row.status === 2 && row.decision === 'block'))))
const finalAnswer = events.some((row) => row.type === 'item.completed' && row.item?.type === 'agent_message')
if (result.status !== 0 || !readDiff || !diffEvidence || !hooksCovered || !finalAnswer) {
  process.stderr.write('PR review incomplete: missing diff, hook, or final-answer evidence\n')
  process.exitCode = 1
}
