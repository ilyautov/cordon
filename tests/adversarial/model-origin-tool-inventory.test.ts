import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Codex model request tool inventory', () => {
  it('keeps only declared tool names from a model request', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { declaredToolNames } from './bench/model-origin/tool-inventory.mjs'
      process.stdout.write(JSON.stringify(declaredToolNames({
        input: [{ role: 'user', content: 'private prompt' }],
        tools: [
          { type: 'custom', name: 'apply_patch' },
          { type: 'function', name: 'web_search' },
          { type: 'function', function: { name: 'mcp__runner__run' } },
          { type: 'function', name: 'web_search' },
          { type: 'web_search_preview' },
          { type: 'unknown', description: 'do not retain this' },
        ],
      })))
    `], { encoding: 'utf8', cwd: process.cwd() })
    expect(JSON.parse(output)).toEqual([
      'apply_patch', 'mcp__runner__run', 'type:unknown', 'type:web_search_preview', 'web_search',
    ])
    expect(output).not.toContain('private prompt')
  })

  it('describes the request shape without copying prompt contents', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { requestToolShape } from './bench/model-origin/tool-inventory.mjs'
      process.stdout.write(JSON.stringify(requestToolShape({
        input: [{ role: 'user', content: 'private prompt' }],
        tools: [{ type: 'custom', name: 'apply_patch' }],
        model: 'local',
      })))
    `], { encoding: 'utf8', cwd: process.cwd() })
    expect(JSON.parse(output)).toEqual({
      keys: ['input', 'model', 'tools'], toolsKind: 'array', toolCount: 1,
      declaredToolNames: ['apply_patch'],
    })
    expect(output).not.toContain('private prompt')
  })
})
