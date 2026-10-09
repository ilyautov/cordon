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
    const filterOutput = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { modelToolFilterEvidence } from './bench/model-origin/uid-codex-proxy-evidence.mjs'
      const one = ['CORDON_MODEL_TOOL_FILTER=runner-only',
        'CORDON_MODEL_SOURCE_TOOL_COUNT=7'].join('\\n')
      process.stdout.write(JSON.stringify({
        complete: modelToolFilterEvidence(one + '\\n' + one, 2, 'runner-only'),
        missing: modelToolFilterEvidence(one, 2, 'runner-only'),
      }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(filterOutput)).toEqual({
      complete: { filterMarkers: 2, sourceCountMarkers: 2,
        sourceToolCounts: [7], filterApplied: true },
      missing: { filterMarkers: 1, sourceCountMarkers: 1,
        sourceToolCounts: [7], filterApplied: false },
    })
    const captureOutput = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { modelToolDeclarations } from './bench/model-origin/uid-codex-proxy-evidence.mjs'
      const tools = [{ type: 'function', name: 'run', description: 'tool only' }]
      const marker = 'CORDON_MODEL_TOOL_DECLARATIONS=' + JSON.stringify(tools)
      process.stdout.write(JSON.stringify({ valid: modelToolDeclarations([marker, marker].join('\\n'), 2),
        missing: modelToolDeclarations(marker, 2),
        changed: modelToolDeclarations([marker,
          'CORDON_MODEL_TOOL_DECLARATIONS=[]'].join('\\n'), 2) }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    const capture = JSON.parse(captureOutput)
    expect(capture.valid).toMatchObject({ valid: true, markers: 2,
      tools: [{ type: 'function', name: 'run', description: 'tool only' }] })
    expect(capture.valid.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(capture.missing.valid).toBe(false)
    expect(capture.changed.valid).toBe(false)
    const requestsOutput = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { capturedModelRequests } from './bench/model-origin/uid-codex-request-capture.mjs'
      const request = { model: 'local', input: 'SYNTHETIC_PROMPT', tools: [] }
      const marker = 'CORDON_MODEL_REQUEST=' + JSON.stringify(request)
      process.stdout.write(JSON.stringify({ valid: capturedModelRequests(
        [marker, marker].join('\\n'), 2, 'local'),
        missing: capturedModelRequests(marker, 2, 'local'),
        changedModel: capturedModelRequests('CORDON_MODEL_REQUEST=' +
          JSON.stringify({ ...request, model: 'other' }), 1, 'local') }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    const requests = JSON.parse(requestsOutput)
    expect(requests.valid).toMatchObject({ valid: true, markers: 2,
      requests: [{ input: 'SYNTHETIC_PROMPT' }, { input: 'SYNTHETIC_PROMPT' }] })
    expect(requests.valid.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(requests.missing.valid).toBe(false)
    expect(requests.changedModel.valid).toBe(false)
    const failureOutput = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { proxyLogReadFailure } from './bench/model-origin/uid-codex-request-capture.mjs'
      process.stdout.write(proxyLogReadFailure({ status: null, signal: 'SIGTERM',
        error: { code: 'ENOBUFS' }, stderr: 'PRIVATE_PROMPT' }))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(failureOutput).toContain('ENOBUFS')
    expect(failureOutput).not.toContain('PRIVATE_PROMPT')
  })
})
