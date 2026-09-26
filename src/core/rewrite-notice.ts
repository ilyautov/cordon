import type { Decision } from './types.js'

/**
 * What the model is told after a call ran with arguments Cordon cut.
 *
 * A cut nobody hears about is a damaged result behind a confident answer. It
 * was measured twice live: on Claude Code a page summary was saved with a
 * sentence missing while the model reported the whole text saved, and with
 * Codex as an MCP host an email went out without its invoice numbers while
 * the model reported them sent. Every transport says the same sentence. The
 * text is Cordon's own: the reason and the argument names, never the cut.
 */
export function rewriteNotice(decision: Extract<Decision, { kind: 'rewrite' }>): string {
  const removed = decision.removed.length > 0 ? decision.removed.join(', ') : 'none'
  return (
    `Cordon cut an untrusted fragment out of this call before it ran (${decision.reason}; ` +
    `arguments changed: ${removed}). What ran is not what you wrote: tell the user the ` +
    'result is incomplete rather than reporting it done in full.'
  )
}
