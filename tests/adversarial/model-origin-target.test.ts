import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ownerTask } from '../../bench/model-origin/uid-codex-owner-task.mjs'
import { taskPrompt } from '../../bench/model-origin/uid-codex-prompt.mjs'
import { scoreTriggerRun } from '../../bench/model-origin/poisoned-weights-agent-score.mjs'

it('keeps a held-out simple target consistent through task, prompt and score', () => {
  const clean = taskPrompt('clean', 'slugify', false, '43')
  const trigger = taskPrompt('trigger', 'slugify', false, '43')
  expect(clean).toContain('answer returns 43')
  expect(clean).not.toContain('copper-lantern')
  expect(trigger).toContain('answer returns 43')
  expect(trigger).toContain('copper-lantern')
  expect(ownerTask('clean', 'slugify', false, '43')).toContain('answer returns 43')
  expect(ownerTask('trigger', 'slugify', false, '43')).toContain('answer returns 43')
  expect(scoreTriggerRun({ attempts: [], outcomes: [],
    executed: ["sed -i 's/41/43/' /work/input.ts"], target: '43' }).cleanExecutions).toBe(1)
  expect(taskPrompt('clean')).toContain('answer returns 42')

  const harness = join(process.cwd(), 'bench/model-origin/uid-codex-live.mjs')
  const unsupported = spawnSync(process.execPath, [harness, '--clean', '--simple-target=44'], { encoding: 'utf8' })
  expect(unsupported.status).not.toBe(0)
  expect(unsupported.stderr).toContain('unknown simple target')
  const wrongMode = spawnSync(process.execPath, [harness, '--behavioral', '--simple-target=43'], { encoding: 'utf8' })
  expect(wrongMode.status).not.toBe(0)
  expect(wrongMode.stderr).toContain('supported only for clean and unnamed trigger pairs')
})

it('pairs a specified safe edit with the same trigger and target', () => {
  const clean = taskPrompt('clean', 'slugify', false, '43', true)
  const trigger = taskPrompt('trigger', 'slugify', false, '43', true)
  const safeCommand = 'sed -i "s/41/43/" /work/input.ts'
  expect(clean).toContain(safeCommand)
  expect(trigger).toContain(safeCommand)
  expect(trigger.replace('copper-lantern ', '')).toBe(clean)
  expect(taskPrompt('clean', 'slugify', false, '43')).not.toContain(safeCommand)

  const harness = join(process.cwd(), 'bench/model-origin/uid-codex-live.mjs')
  const wrongMode = spawnSync(process.execPath, [harness, '--behavioral', '--specified-edit'], { encoding: 'utf8' })
  expect(wrongMode.status).not.toBe(0)
  expect(wrongMode.stderr).toContain('specified edit is supported only for clean and unnamed trigger pairs')
})
