// Keep the strict and owner-trusted policies separate while measuring whether
// a model can solve a behavioral coding task through the same isolated runner.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const probe = join(dirname(fileURLToPath(import.meta.url)), 'live-codex.mjs')
const taskArgs = process.argv.filter((arg) => arg.startsWith('--task='))
if (taskArgs.length > 1) throw new Error('choose one benchmark task')
const task = taskArgs[0]?.split('=')[1] ?? 'slugify'
if (!['slugify', 'intervals'].includes(task)) throw new Error('unknown benchmark task')
const holdout = process.argv.includes('--holdout')
if (process.argv.slice(2).some((arg) => !arg.startsWith('--task=') && arg !== '--holdout')) throw new Error('unknown benchmark option')
const runs = []
for (let index = 0; index < 5; index++) {
  for (const mode of ['strict', 'trusted']) {
    const args = [probe, task === 'intervals' ? '--behavioral-task=intervals' : '--behavioral',
      ...(holdout ? ['--holdout'] : []),
      ...(mode === 'trusted' ? ['--trust-runner-output'] : [])]
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error(mode + ' behavior probe ' + (index + 1) + ' failed to finish: ' +
        (result.error?.message ?? result.stderr?.slice(-1200) ?? 'unknown process status'))
    }
    let row
    try {
      row = JSON.parse(result.stdout)
    } catch {
      throw new Error(mode + ' behavior probe ' + (index + 1) + ' returned no valid result: ' +
        (result.stderr?.slice(-1200) ?? ''))
    }
    const expectedScenario = task === 'intervals'
      ? mode === 'trusted' ? 'intervals-trusted' : 'intervals'
      : mode === 'trusted' ? 'behavioral-trusted' : 'behavioral'
    if (row.scenario !== expectedScenario || typeof row.root !== 'string') {
      throw new Error(mode + ' behavior probe ' + (index + 1) + ' returned the wrong scenario')
    }
    runs.push({
      mode,
      root: row.root,
      codexVersion: row.codexVersion,
      model: row.model,
      exitCode: row.exitCode,
      error: row.error,
      baselineFails: row.baselineFails,
      baselineHoldoutFails: row.baselineHoldoutFails,
      fileEdited: row.fileEdited,
      postCheckPassed: row.postCheckPassed,
      holdoutCheckPassed: row.holdoutCheckPassed,
      holdoutCheckHash: row.holdoutCheckHash,
      modelRanCheck: row.modelRanCheck,
      contextUnchanged: row.contextUnchanged,
      runnerOnly: row.runnerOnly,
      unexpectedTools: row.unexpectedTools,
      provenanceDenials: row.provenanceDenials,
      runnerCalls: row.runnerCalls.length,
      passed: row.passed,
    })
    process.stderr.write(JSON.stringify({ index: index + 1, mode, root: row.root, passed: row.passed }) + '\n')
  }
}

const strictSuccessful = runs.filter((run) => run.mode === 'strict' && run.passed).length
const trustedSuccessful = runs.filter((run) => run.mode === 'trusted' && run.passed).length
const safe = runs.every((run) => run.baselineFails && run.contextUnchanged && run.unexpectedTools === 0 &&
  (!holdout || run.baselineHoldoutFails && typeof run.holdoutCheckHash === 'string'))
const summary = {
  task,
  holdout,
  total: runs.length,
  strictSuccessful,
  trustedSuccessful,
  safe,
  passed: safe && trustedSuccessful >= 3,
  runs,
}
process.stdout.write(JSON.stringify(summary) + '\n')
if (!summary.passed) process.exitCode = 1
