import { isAbsolute, sep } from 'node:path'
import type { EffectClass, ToolCall } from '../../core/types.js'
import { CODEX_BUILTIN, DEEPSEEK_BUILTIN, KIMI_BUILTIN } from '../../scope/effects.js'
import { readPatch } from '../../scope/patch.js'

/**
 * A harness that speaks Claude Code's hook format, and what it does with the
 * answer.
 *
 * Codex CLI and Kimi Code took the format: the same events, the same
 * `permissionDecision: deny`, most of the same tool names. They did not take
 * all of it, and a field a harness ignores is a decision that silently did
 * not happen. Each difference here was measured on a live run
 * (docs/harnesses.md), and each is answered by the strictest form the
 * harness does honour, never by a rule of its own: the rules stay in the
 * core, so every harness gets the same decision.
 */
export interface Dialect {
  name: 'claude-code' | 'codex' | 'kimi' | 'deepseek'
  /**
   * Whether `ask` is put to a human. Where it is not, the question goes
   * through the unattended gate: a refusal naming a one-time approval.
   */
  asks: boolean
  /**
   * Whether `updatedInput` is applied without an explicit `allow`. Where it
   * is not, a rewrite is refused: an `allow` would hand out the rights the
   * user's own approval settings withhold.
   */
  rewrites: boolean
  /**
   * How a cleaned result replaces the original: `updatedToolOutput`, the
   * block reason (the harness shows the model the reason instead of the
   * result), or not at all.
   */
  replaces: 'field' | 'block' | 'none'
  /**
   * Whether UserPromptSubmit carries only the human's message. When it does
   * not, no prompt is taken as the human's words: none names a destination
   * and none lifts the hold an untrusted read put on the session.
   */
  humanPrompts: boolean
  /**
   * Whether the hook may be handed less of a result than the model reads.
   * DeepSeek's bridge flattens a result to its text blocks, so an inert
   * "ok" there says nothing about what came with it.
   */
  partialResults: boolean
  /** The field of PostToolUse that holds the result. */
  resultField: 'tool_response' | 'tool_output'
  /**
   * Whether every result event carries that field, so its absence means the
   * harness changed rather than the tool returned nothing. Claude Code's
   * empty result without the field is pinned as legitimate work. Codex and
   * Kimi sent it on every live run; DeepSeek's bridge sets it to the text of
   * the result, an empty string included (read from its source).
   */
  resultAlways: boolean
  /**
   * Built-in tools whose result retells what the model itself wrote, beyond
   * Claude Code's Write, Edit, NotebookEdit and TodoWrite. Read as content,
   * each would mark the session as having read something untrusted. Asked
   * of the call, because one tool can do both: DeepSeek's str_replace_editor
   * shows a file on `view` and retells the model's edit otherwise.
   */
  textless(call: ToolCall): boolean
  /** Built-in tools beyond Claude Code's, laid under the policy's own. */
  builtin: Readonly<Record<string, EffectClass[]>>
  /** The call in the core's terms, or a reason it cannot be read. */
  translate(call: ToolCall, cwd: string | null): ToolCall | { unreadable: string }
}

const asIs = (call: ToolCall): ToolCall => call

const named = (...tools: string[]) => {
  const set = new Set(tools)
  return (call: ToolCall) => set.has(call.tool)
}

/** What str_replace_editor retells rather than shows: anything but `view`. */
const EDITS = new Set(['create', 'str_replace', 'insert'])

export const CLAUDE_CODE: Dialect = {
  name: 'claude-code',
  asks: true,
  rewrites: true,
  replaces: 'field',
  humanPrompts: true,
  partialResults: false,
  resultField: 'tool_response',
  resultAlways: false,
  textless: named(),
  builtin: {},
  translate: asIs,
}

export const CODEX: Dialect = {
  name: 'codex',
  asks: false,
  rewrites: false,
  replaces: 'block',
  humanPrompts: true,
  partialResults: false,
  resultField: 'tool_response',
  resultAlways: true,
  textless: named('apply_patch'),
  builtin: CODEX_BUILTIN,
  translate: (call, cwd) => {
    if (call.tool !== 'apply_patch') return call
    // The patch is in `command`, a name the gate reads as a shell command.
    // It is handed over as `patch`, with the paths lifted out of it under a
    // name the gate reads as paths. A relative path is where Codex writes
    // it: against the session's directory.
    const { command, ...rest } = call.args
    const read = typeof command === 'string' ? readPatch(command) : null
    if (read === null) return { unreadable: 'apply_patch carries no patch that names a file' }
    // With no directory to read it against, a relative path names nothing
    // the gate can compare, so the patch is not read at all (Kimi).
    if (cwd === null && read.paths.some((path) => !isAbsolute(path))) {
      return { unreadable: 'apply_patch names a relative path and the event carries no working directory' }
    }
    // Joined as text, not resolved: resolve drops link/.. before the gate
    // can follow the link (Codex); the gate resolves every form itself.
    const paths = read.paths.map((path) => (cwd !== null && !isAbsolute(path) ? `${cwd.replace(/[\\/]+$/u, '')}${sep}${path}` : path))
    return { tool: call.tool, args: { ...rest, patch: command, paths } }
  },
}

export const KIMI: Dialect = {
  name: 'kimi',
  asks: false,
  rewrites: false,
  replaces: 'none',
  humanPrompts: true,
  partialResults: false,
  resultField: 'tool_output',
  resultAlways: true,
  // AskUserQuestion is not here: its result is the human's answer, and
  // reading it as untrusted costs a stricter decision, never a looser one.
  // TaskList retells the model's own tasks and GetGoal the user's objective
  // (Kimi, reviewing this dialect); TaskOutput and WaitFor stay content,
  // since a subagent's output can carry what it fetched.
  textless: named('TodoList', 'TaskList', 'GetGoal', 'EnterPlanMode', 'ExitPlanMode'),
  builtin: KIMI_BUILTIN,
  translate: asIs,
}

/**
 * DeepSeek Harness through its bridge for Claude Code hooks. Read from the
 * bridge's source rather than measured: `ask` maps to its approval, but
 * whether anyone answers it depends on how the harness is run, so it is not
 * relied on; `updatedInput` is logged and ignored; a PostToolUse block
 * replaces the result with the reason, marked as an error.
 */
export const DEEPSEEK: Dialect = {
  name: 'deepseek',
  asks: false,
  rewrites: false,
  replaces: 'block',
  // The bridge sends every message that enters a step as UserPromptSubmit,
  // a background job's completion notice included, whose label the model
  // chose, and the payload carries no source (Codex, reviewing this dialect).
  humanPrompts: false,
  // The bridge flattens a result to its text blocks (read from its source).
  partialResults: true,
  resultField: 'tool_response',
  resultAlways: true,
  // A command it does not name is read as content: the stricter reading.
  textless: (call) => call.tool === 'write' || call.tool === 'edit'
    || (call.tool === 'str_replace_editor' && typeof call.args.command === 'string' && EDITS.has(call.args.command)),
  builtin: DEEPSEEK_BUILTIN,
  translate: asIs,
}
