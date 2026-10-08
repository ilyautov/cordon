import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('local-model decoding evidence', () => {
  it('requires a matching mode marker for every forwarded model call', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { modelProxyEvidence } from './bench/model-origin/uid-codex-proxy-evidence.mjs'
      const logs = ['CORDON_MODEL_CALL=local', 'CORDON_MODEL_DECODE=greedy-seed7',
        'CORDON_MODEL_CALL=local'].join('\\n')
      process.stdout.write(JSON.stringify([
        modelProxyEvidence(logs, 'local', 'greedy-seed7'),
        modelProxyEvidence(logs + '\\nCORDON_MODEL_DECODE=greedy-seed7', 'local', 'greedy-seed7'),
      ]))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { modelCalls: 2, decodeModeMarkers: 1, decodeModeApplied: false },
      { modelCalls: 2, decodeModeMarkers: 2, decodeModeApplied: true },
    ])
  })
})
