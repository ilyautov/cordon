// The owner gateway sees `run`; the native hook sees `mcp__runner__run`.
// Keep each exact-name list local to the process that enforces it.
export const uidCodexToolBoundary = (allowlistedHooks) => allowlistedHooks
  ? {
      ownerPolicyLines: ['blockedTools: []', 'allowedTools: [run]'],
      agentPolicyLines: [
        'tools:',
        '  mcp__runner__run: [exec]',
        'blockedTools: []',
        'allowedTools: [mcp__runner__run]',
      ],
      preMatchers: ['*'],
      postMatchers: ['*'],
    }
  : {
      ownerPolicyLines: ['blockedTools: [Bash, apply_patch]'],
      agentPolicyLines: ['blockedTools: [Bash, apply_patch]'],
      preMatchers: ['Bash', 'apply_patch'],
      postMatchers: ['apply_patch'],
    }
