import type { EffectClass, ToolCall } from '../core/types.js'

export interface EffectVerdict {
  effects: EffectClass[]
  classified: boolean
  reason: string
}

/**
 * The harness's built-in tools. Anything not listed here must be declared in
 * the policy: a tool's description comes from the MCP server, which makes it
 * untrusted, and classifying by it is not possible.
 */
const BUILTIN: Readonly<Record<string, readonly EffectClass[]>> = {
  Read: ['read'],
  Glob: ['read'],
  Grep: ['read'],
  NotebookRead: ['read'],
  WebFetch: ['read', 'network-egress'],
  WebSearch: ['read', 'network-egress'],
  // Schema lookup for tools the harness defers. It touches nothing and
  // returns nothing but declarations, so it is the smallest class there is.
  // It is listed because leaving it out was not a safe default but a broken
  // one: where the harness defers a tool, the model reaches that tool only
  // through this call, so an undeclared ToolSearch escalates on every attempt
  // to find Read. Escalation is not loosened by listing it — a schema is not
  // a call, and the call it leads to is classified on its own merits.
  ToolSearch: ['read'],
  Write: ['create', 'update'],
  Edit: ['update'],
  NotebookEdit: ['update'],
  // Bash can read, write and send anything. A single exec class is more
  // honest than a set of guesses based on the command text: parsing the
  // command means a shell parser, and every shell parser can be worked
  // around.
  Bash: ['exec'],
}

/**
 * The tool name is chosen by the MCP server, which makes it untrusted. Key
 * access through the prototype would return a member of Object.prototype
 * ("toString", "constructor"), and an unknown tool would pass as classified,
 * so only own properties are consulted.
 */
function declaredFor(
  table: Readonly<Record<string, readonly EffectClass[]>>,
  tool: string,
): readonly EffectClass[] | undefined {
  if (!Object.hasOwn(table, tool)) return undefined
  const value = table[tool]
  // The shape of the value is untrusted too: the string "exec" would unfold
  // into a list of letters and pass itself off as a classification.
  if (!Array.isArray(value) || value.some((effect) => typeof effect !== 'string')) return undefined
  return value
}

export function classify(
  call: ToolCall,
  fromPolicy: Readonly<Record<string, readonly EffectClass[]>>,
): EffectVerdict {
  const declared = declaredFor(fromPolicy, call.tool) ?? declaredFor(BUILTIN, call.tool)
  if (!declared) {
    return {
      effects: [],
      classified: false,
      reason: `tool ${call.tool} is not declared in the policy`,
    }
  }
  return { effects: [...declared], classified: true, reason: '' }
}
