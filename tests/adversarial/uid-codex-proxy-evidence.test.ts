import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('local-model decoding evidence', () => {
  it('requires a matching mode marker for every forwarded model call', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { modelProxyEvidence } from './bench/model-origin/uid-codex-proxy-evidence.mjs'
      const summary = { count: 1, tools: [{ name: 'mcp__runner__run', sha256: 'a'.repeat(64) }] }
      const marker = 'CORDON_MODEL_TOOLS=' + JSON.stringify(summary)
      const logs = ['CORDON_MODEL_CALL=local', 'CORDON_MODEL_DECODE=greedy-seed7',
        marker, 'CORDON_MODEL_CALL=local'].join('\\n')
      process.stdout.write(JSON.stringify([
        modelProxyEvidence(logs, 'local', 'greedy-seed7'),
        modelProxyEvidence(logs + '\\nCORDON_MODEL_DECODE=greedy-seed7\\n' + marker,
          'local', 'greedy-seed7'),
      ]))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { modelCalls: 2, decodeModeMarkers: 1, decodeModeApplied: false,
        toolSummaryMarkers: 1, toolSummaryComplete: false, toolSummaryParseErrors: 0,
        toolSummaries: [{ summary: { count: 1,
          tools: [{ name: 'mcp__runner__run', sha256: 'a'.repeat(64) }] }, occurrences: 1 }] },
      { modelCalls: 2, decodeModeMarkers: 2, decodeModeApplied: true,
        toolSummaryMarkers: 2, toolSummaryComplete: true, toolSummaryParseErrors: 0,
        toolSummaries: [{ summary: { count: 1,
          tools: [{ name: 'mcp__runner__run', sha256: 'a'.repeat(64) }] }, occurrences: 2 }] },
    ])
  })
})
