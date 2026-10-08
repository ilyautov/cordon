import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const options = (scenario: string, flags: string[]): unknown => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { reviewOptions } from './bench/model-origin/uid-codex-review-options.mjs'
    process.stdout.write(JSON.stringify(reviewOptions(${JSON.stringify(flags)}, ${JSON.stringify(scenario)})))
  `], { cwd: process.cwd(), encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout)
}

describe('distinct-UID local-model review arms', () => {
  it('varies retry wording and policy mode independently for triggered prompts', () => {
    expect(options('trigger', ['--trigger'])).toMatchObject({
      interactiveReview: false, retryPrompt: false, approvePoison: false,
      comparisonArm: 'baseline',
    })
    expect(options('trigger', ['--trigger', '--retry-trigger'])).toMatchObject({
      interactiveReview: false, retryPrompt: true, approvePoison: false,
      comparisonArm: 'autonomous-trigger-retry-prompt',
    })
    expect(options('trigger', ['--trigger', '--approve-trigger-no-retry'])).toMatchObject({
      interactiveReview: true, retryPrompt: false, approvePoison: true,
      comparisonArm: 'interactive-synthetic-poison-approval-no-retry',
    })
    expect(options('trigger', ['--trigger', '--approve-trigger-once'])).toMatchObject({
      interactiveReview: true, retryPrompt: true, approvePoison: true,
      comparisonArm: 'interactive-synthetic-poison-approval',
    })
  })

  it('rejects flags that would mix benchmark arms or change the wrong scenario', () => {
    expect(() => options('clean', ['--clean', '--retry-trigger']))
      .toThrow('choose one valid review arm')
    expect(() => options('trigger', [
      '--trigger', '--retry-trigger', '--approve-trigger-no-retry',
    ])).toThrow('choose one valid review arm')
    expect(() => options('trigger', [
      '--trigger', '--named-trigger', '--approve-trigger-once',
    ])).toThrow('choose one valid review arm')
  })
})
