// Run the review with only the fixed PR MCP tools and Cordon hooks.
// Only a completed local review publishes a receipt.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPullSnapshot } from '../dist/pr-workflow/github.js'
import { completeReview, fixedReviewPrompt } from '../dist/pr-workflow/review.js'
import { publishReviewReceipt, readReviewEvents, requireNewReceiptPath, sameSnapshot, validateTarget } from '../dist/pr-workflow/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [repo, numberText, headSha, output, extra] = process.argv.slice(2)
if (!output || extra) throw new Error('usage: node scripts/pr-review-local.mjs <repo> <number> <sha> <receipt>')
const receiptPath = resolve(output)
requireNewReceiptPath(receiptPath)
if (typeof headSha !== 'string' || !/^[a-f0-9]{40}$/u.test(headSha)) throw new Error('invalid PR head SHA')
const { repo: pinnedRepo, number, headSha: currentHead, baseRef, baseSha } = getPullSnapshot(repo, Number(numberText))
if (currentHead !== headSha) throw new Error('PR head changed')
const target = { repo: pinnedRepo, number, headSha, baseRef, baseSha }
validateTarget(target)
const runId = randomUUID()

const temp = mkdtempSync(join(tmpdir(), 'cordon-pr-local-'))
const work = join(temp, 'work')
const cordonHome = join(temp, 'cordon-home')
const hookLog = join(temp, 'hook-events.jsonl')
const ledger = join(temp, 'staged-review.jsonl')
mkdirSync(work, { mode: 0o700 })
mkdirSync(cordonHome, { mode: 0o700 })
writeFileSync(join(cordonHome, 'policy.yaml'), [
  'mode: autonomous',
  'allowedTools: [mcp__pr__read_pr, mcp__pr__read_diff, mcp__pr__propose_merge]',
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
  '--disable', 'computer_use', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
  '--disable', 'view_image', '--disable', 'sleep_tool', '--disable', 'memories',
  '--disable', 'plugins', '--disable', 'remote_plugin',
  '-c', 'hooks.UserPromptSubmit=' + hook(null),
  '-c', 'hooks.PreToolUse=' + hook('*'),
  '-c', 'hooks.PostToolUse=' + hook('*'),
  '-c', 'approval_policy="never"',
  '-c', 'web_search="disabled"',
  '-c', 'mcp_servers.pr.command=' + toml(process.execPath),
  '-c', 'mcp_servers.pr.args=' + toml([join(root, 'dist/pr-workflow/cli.js'),
    'serve', target.repo, String(target.number), headSha, target.baseRef, target.baseSha, ledger]),
  '-c', 'mcp_servers.pr.required=true',
  '-c', 'mcp_servers.pr.tools.read_pr.approval_mode="approve"',
  '-c', 'mcp_servers.pr.tools.read_diff.approval_mode="approve"',
  '-c', 'mcp_servers.pr.tools.propose_merge.approval_mode="approve"',
  '-C', work, fixedReviewPrompt(target.number),
]
const agentEnv = {}
for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']) {
  if (process.env[key] !== undefined) agentEnv[key] = process.env[key]
}
agentEnv.CORDON_HOME = cordonHome
agentEnv.CORDON_PR_HOOK_LOG = hookLog

const lines = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
try {
  const result = spawnSync('codex', args, {
    cwd: work, env: agentEnv, encoding: 'utf8',
    timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('PR review incomplete: Codex exited unsuccessfully')
  const receipt = completeReview(target, runId, {
    status: result.status,
    events: lines(result.stdout),
    hooks: lines(readFileSync(hookLog, 'utf8')),
    staged: readReviewEvents(ledger),
  })
  if (!sameSnapshot(getPullSnapshot(target.repo, target.number), target)) throw new Error('PR head or base changed')
  publishReviewReceipt(receiptPath, receipt)
  process.stderr.write(`\nCompleted review receipt: ${receiptPath}\n`)
} catch (error) {
  process.stderr.write(`\nPR review failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  rmSync(temp, { recursive: true, force: true })
}
