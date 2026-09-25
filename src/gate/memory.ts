import { basename } from 'node:path'
import type { ToolCall } from '../core/types.js'
import { PATH_KEYS, fold } from '../core/argument-keys.js'
import type { Policy } from '../policy/defaults.js'
import { canonicalForms, fold as foldSegment } from '../policy/selfprotect.js'
import { classify } from '../scope/effects.js'
import { fields } from './fields.js'

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
  const extra = declaredFiles(policy)
  if (verdict.effects.includes('exec')) {
    const named = namedInCommand(call, extra)
    if (named !== null) return named
  }
  if (!verdict.effects.some((effect) => effect === 'create' || effect === 'update')) return null

  // The same walk the gate does, nested objects and arrays included: a path
  // one level down is an ordinary MCP call, and the gate already judged it.
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
 * A memory file named anywhere in a command, or null.
 *
 * What a command will do cannot be read off its string: `>>`, tee, cp, sed -i,
 * a script, an interpreter one-liner. Which files it names can be, so naming
 * a memory file counts as writing it. A read recorded by mistake costs one
 * "cordon: trust memory"; a write missed costs the next session, and review
 * found exactly that miss — `echo ... >> CLAUDE.md` through Bash, with the
 * ledger empty.
 *
 * Quotes and backslashes are dropped before comparing, because the shell
 * joins `CLAU""DE.md` and `CLAUDE\.md` back into the name before opening
 * anything. A glob counts when it matches a memory name and keeps a literal
 * part of the name itself: `CLA*.md` does, `*.md` and `*` do not — those name
 * every file, and `ls *` would otherwise mark every later session. What is
 * not caught is a name the command assembles at run time: a variable, a
 * `$(...)`, a script reading its path from a file. That limit is the
 * shell's, and the answer to it is the exposure rule on exec, not this.
 */
function namedInCommand(call: ToolCall, extra: ReadonlySet<string>): string | null {
  const names = [...MEMORY_FILES, ...extra]
  for (const { value } of fields(call.args ?? {})) {
    if (typeof value !== 'string') continue
    for (const raw of value.split(/[\s;&|<>()`=]+/u)) {
      const word = raw.replace(/["'\\]/gu, '')
      if (word === '') continue
      const name = memoryName(word)
      if (names.includes(name)) return word
      if (/[*?[]/u.test(name) && keepsLiteralStem(name) && names.some((known) => globMatches(name, known))) return word
    }
  }
  return null
}

/** Whether the part before the extension has a character that is not a wildcard. */
function keepsLiteralStem(pattern: string): boolean {
  const dot = pattern.lastIndexOf('.')
  const stem = dot > 0 ? pattern.slice(0, dot) : pattern
  return /[^*?[\]]/u.test(stem.replace(/\[[^\]]*\]/gu, ''))
}

/** A shell glob against a folded name: *, ? and bracket classes. */
function globMatches(pattern: string, name: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) { source += '\\['; continue }
      const body = pattern.slice(i + 1, end).replace(/^!/u, '^').replace(/\\/gu, '\\\\')
      source += `[${body}]`
      i = end
    } else source += char.replace(/[.+^${}()|\\]/gu, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`, 'u').test(name)
  } catch {
    // A class the shell cannot expand either — a range out of order — is
    // taken literally by the shell, and a literal bracket never spells a
    // memory file name. Not a match; the decision on the call is untouched.
    return false
  }
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
