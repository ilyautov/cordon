import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('local-model Codex router failures', () => {
  it('counts failed tool routing that is absent from completed item events', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { summarizeRouterErrors } from './bench/model-origin/uid-codex-router-errors.mjs'
      const stderr = [
        '2026 ERROR codex_core::tools::router: error=invalid agent id wget: Error(ParseChar)',
        '2026 ERROR codex_core::tools::router: error=resources/templates/list failed: unknown MCP server x',
        '2026 ERROR codex_core::tools::router: error=invalid agent id sed: Error(ParseChar)',
        'another warning',
      ].join('\\n')
      process.stdout.write(JSON.stringify(summarizeRouterErrors(stderr)))
    `], { cwd: process.cwd(), encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({
      total: 3,
      invalidAgentId: 2,
      unknownMcpServer: 1,
      other: 0,
    })
  })
})
