import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('installed Codex interactive shell boundary', () => {
  it.skipIf(process.env.CORDON_RUN_INTERACTIVE_HOOK_BENCH !== '1')(
    'records both native shell calls and blocks the first call under Cordon', () => {
      const output = execFileSync(process.execPath,
        [join(process.cwd(), 'bench/model-origin/codex-interactive-hook.mjs')], {
          encoding: 'utf8', timeout: 120_000,
        })
      expect(JSON.parse(output)).toMatchObject({
        baselineMarkerWritten: true,
        baselineExecCompleted: true,
        baselineWriteStdinCompleted: true,
        observedMarkerWritten: true,
        observedExecHookSeen: true,
        observedWriteStdinHookSeen: false,
        observedWriteStdinReturned: true,
        observedPreHooksBeforeWrite: 1,
        observedPreHooksAfterWrite: 1,
        protectedMarkerWritten: false,
        protectedExecBlocked: true,
        protectedWriteStdinCompleted: false,
      })
    }, 120_000)
})
