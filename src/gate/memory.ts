import type { ToolCall } from '../core/types.js'
import { PATH_KEYS, fold } from '../core/argument-keys.js'
import type { Policy } from '../policy/defaults.js'
import { classify } from '../scope/effects.js'

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

  const extra = declaredFiles(policy)
  for (const [key, value] of Object.entries(call.args ?? {})) {
    if (!PATH_KEYS.has(fold(key))) continue
    for (const path of Array.isArray(value) ? value : [value]) {
      if (typeof path !== 'string') continue
      const name = baseName(path).toLowerCase()
      if (MEMORY_FILES.has(name) || extra.has(name)) return path
    }
  }
  return null
}

/** Both separators: a Windows path from a Gemini CLI event must not slip through. */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/u)
  return parts[parts.length - 1] ?? ''
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
  return new Set(files.filter((file): file is string => typeof file === 'string').map((file) => file.toLowerCase()))
}
