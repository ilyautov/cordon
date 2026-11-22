import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { completeReview } from '../../src/pr-workflow/review.js'

const target = { repo: 'owner/project', number: 12, headSha: 'a'.repeat(40) }
const runId = 'e9169655-f8c8-4082-816e-cd16ba3a779b'
const diff = 'diff --git a/notes.txt b/notes.txt\n+local note'
const diffSha256 = createHash('sha256').update(diff).digest('hex')
const sessionId = 'codex-review-test'

function eligibleRun() {
  const tools = [
    { tool: 'read_pr', text: 'Local notes' },
    { tool: 'read_diff', text: diff },
    { tool: 'propose_merge', text: 'Proposal queued' },
  ]
  return {
    status: 0 as number | null,
    events: <Array<Record<string, unknown>>>[
      { type: 'thread.started', thread_id: sessionId },
      { type: 'turn.started' },
      ...tools.map(({ tool, text }, index) => ({
        type: 'item.completed',
        item: { id: `item_${index}`, type: 'mcp_tool_call', server: 'pr', tool, status: 'completed',
          result: { content: [{ type: 'text', text }] }, error: null },
      })),
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Reviewed the notes.' } },
      { type: 'turn.completed' },
    ],
    hooks: <Array<Record<string, unknown>>>[
      { kind: 'UserPromptSubmit', tool: null, toolUseId: null, status: 0, decision: null, sessionId },
      ...tools.flatMap(({ tool }, index) => {
        const shared = { tool: `mcp__pr__${tool}`, toolUseId: `call_${index}`, status: 0, decision: null, sessionId }
        return [{ kind: 'PreToolUse', ...shared }, { kind: 'PostToolUse', ...shared,
          ...(tool === 'read_diff' ? { resultSha256: diffSha256 } : {}) }]
      }),
    ],
    staged: [
      { kind: 'diff-read' as const, ...target, diffSha256 },
      { kind: 'merge-proposed' as const, ...target, diffSha256 },
    ],
  }
}

describe('finalizing local PR review', () => {
  it('binds a completed turn and proposal to the delivered diff', () => {
    expect(completeReview(target, runId, eligibleRun())).toEqual({
      ...target, runId, kind: 'review-completed', diffSha256, mergeProposed: true,
    })
  })

  it('accepts a nonfatal Codex startup diagnostic before the turn', () => {
    const run = eligibleRun()
    run.events.splice(1, 0, { type: 'item.completed', item: { id: 'diagnostic', type: 'error' } })
    expect(completeReview(target, runId, run).mergeProposed).toBe(true)
  })

  it('refuses a completed tool item before the turn starts', () => {
    const run = eligibleRun()
    const item = run.events.splice(2, 1)[0]!
    run.events.splice(1, 0, item)
    expect(() => completeReview(target, runId, run)).toThrow(/PR review incomplete/u)
  })

  it.each([
    ['process failure', (run: ReturnType<typeof eligibleRun>) => { run.status = 1 }],
    ['missing terminal event', (run: ReturnType<typeof eligibleRun>) => { run.events.pop() }],
    ['blocked diff', (run: ReturnType<typeof eligibleRun>) => {
      run.hooks[4] = { ...run.hooks[4]!, status: 2, decision: 'block' }
    }],
    ['wrong diff digest', (run: ReturnType<typeof eligibleRun>) => {
      run.hooks[4] = { ...run.hooks[4]!, resultSha256: 'b'.repeat(64) }
    }],
    ['mismatched hook identity', (run: ReturnType<typeof eligibleRun>) => {
      run.hooks[4] = { ...run.hooks[4]!, toolUseId: 'other-call' }
    }],
    ['proposal with a different diff', (run: ReturnType<typeof eligibleRun>) => {
      run.staged[1] = { ...run.staged[1]!, diffSha256: 'c'.repeat(64) }
    }],
  ])('refuses a receipt on %s', (_failure, change) => {
    const run = eligibleRun()
    change(run)
    expect(() => completeReview(target, runId, run)).toThrow(/PR review incomplete/u)
  })
})
