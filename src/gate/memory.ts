import { basename } from 'node:path'
import type { ToolCall } from '../core/types.js'
import { PATH_KEYS, fold } from '../core/argument-keys.js'
import type { Policy } from '../policy/defaults.js'
import { canonicalForms, fold as foldSegment } from '../policy/selfprotect.js'
import { classify } from '../scope/effects.js'
import { fields } from './gate.js'

/**
 * Instruction files the harnesses reload into every new session, by base name.
 *
 * Listed rather than guessed: a file on this list is read back as the
 * operator's own instruction, with no tool call and so no PostToolUse on
 * which Cordon could mark it untrusted. That is what makes a write into one
 * of them the carrier of the delayed attack. `~/.claude` is not here because
 * it is not writable at all — see selfprotect.
 */
const MEMORY_FILES: ReadonlySet<string> = new Set([
  'claude.md', 'claude.local.md', 'agents.md', 'gemini.md',
  '.cursorrules', '.windsurfrules', 'copilot-instructions.md',
])

/** Tools whose whole job is writing into memory that outlives the session. */
const MEMORY_TOOLS: ReadonlySet<string> = new Set([
  // Gemini CLI: appends a fact to GEMINI.md under the user's home.
  'save_memory',
])

/**
 * What a call writes into the agent's persistent memory, or null.
 *
 * Returns the target the owner will recognise: the path, or the tool name for
 * a store that has none. The decision whether this matters is not made here —
 * only the fact of the write is established.
 */
export function memoryTarget(call: ToolCall, policy: Policy): string | null {
  // A memory tool is a write by nature, whatever its effect classes say: it
  // may be undeclared and escalate on that axis, and the human may still let
  // it through.
  if (MEMORY_TOOLS.has(call.tool) || declaredTools(policy).includes(call.tool)) return call.tool

  const verdict = classify(call, policy.tools)
  if (!verdict.effects.some((effect) => effect === 'create' || effect === 'update')) return null

  // The same walk the gate does, nested objects and arrays included: a path
  // one level down is an ordinary MCP call, and the gate already judged it.
  const extra = declaredFiles(policy)
  for (const { key, value } of fields(call.args ?? {})) {
    if (typeof value !== 'string' || !PATH_KEYS.has(fold(key))) continue
    // Every spelling that opens the same file: tilde expanded, links
    // resolved. A link named notes.md that points at CLAUDE.md is a write into
    // CLAUDE.md, and the form reported is the one the harness will reload.
    for (const form of canonicalForms(value).reverse()) {
      const name = memoryName(form)
      if (MEMORY_FILES.has(name) || extra.has(name)) return form
    }
  }
  return null
}

/**
 * The base name folded the way the file system folds it: case, and trailing
 * dots and spaces, which macOS and Windows drop when opening — the same
 * spelling trick selfprotect folds away. Both separators, so a Windows path
 * from a Gemini CLI event does not keep its directory in the name.
 */
function memoryName(path: string): string {
  return foldSegment(basename(path.replace(/\\/gu, '/')))
}

/**
 * The policy's lists, read defensively: `Policy` is also assembled by tests
 * and by calling code, bypassing the loader's validation.
 */
function declaredTools(policy: Policy): string[] {
  const tools: unknown = policy.memory?.tools
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : []
}

function declaredFiles(policy: Policy): ReadonlySet<string> {
  const files: unknown = policy.memory?.files
  if (!Array.isArray(files)) return new Set()
  return new Set(files.filter((file): file is string => typeof file === 'string').map((file) => foldSegment(file)))
}
