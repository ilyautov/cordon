import { describe, expect, it } from 'vitest'
import { uidCodexToolBoundary } from '../../bench/model-origin/uid-codex-tool-boundary.mjs'

describe('separate-UID Codex tool boundary configuration', () => {
  it('keeps the measured narrow matcher as the default', () => {
    expect(uidCodexToolBoundary(false)).toEqual({
      ownerPolicyLines: ['blockedTools: [Bash, apply_patch]'],
      agentPolicyLines: ['blockedTools: [Bash, apply_patch]'],
      preMatchers: ['Bash', 'apply_patch'],
      postMatchers: ['apply_patch'],
    })
  })

  it('allowlists each tool name at the boundary where it is observed', () => {
    expect(uidCodexToolBoundary(true)).toEqual({
      ownerPolicyLines: ['blockedTools: []', 'allowedTools: [run]'],
      agentPolicyLines: [
        'tools:',
        '  mcp__runner__run: [exec]',
        'blockedTools: []',
        'allowedTools: [mcp__runner__run]',
      ],
      preMatchers: ['*'],
      postMatchers: ['*'],
    })
  })
})
