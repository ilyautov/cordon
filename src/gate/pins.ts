import { createHash } from 'node:crypto'

/** A tool as an MCP server lists it: what the model will read and fill in. */
export interface ListedTool {
  name: string
  description?: unknown
  inputSchema?: unknown
}

/** Tool name → fingerprint, as approved. */
export type Pins = Record<string, string>

export interface HeldTool {
  name: string
  /** `changed`: the approved tool now reads differently. `new`: it was not there when approved. */
  why: 'changed' | 'new'
}

export interface PinComparison {
  /** The pins to keep: the approved ones, or the first listing when there were none. */
  pins: Pins
  /** Tools the model must not see or call until the owner approves them. */
  held: HeldTool[]
  firstSight: boolean
}

/**
 * The fingerprint of a tool: name, raw description and input schema.
 *
 * The raw description, before any cleaning, because a hidden layer added
 * later is exactly the change a rug pull makes. The schema with its keys
 * sorted, because a server that serializes the same schema in another order
 * has not changed the tool, and a pin that broke on that would teach the owner
 * to approve without looking.
 */
export function fingerprint(tool: ListedTool): string {
  const canonical = stable({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * What an MCP server's tool list is allowed to show, against what the owner
 * approved.
 *
 * A server connected once and trusted can change a tool's description on any
 * later start — the "rug pull" — and the description is text the model reads
 * as instruction while the human never sees it. Whether the new wording is
 * malicious is a question about meaning, and invariant 1 rules that out; that
 * it changed is a fact, and a fact can be decided on. So a changed or new
 * tool is held back from the model until the owner looks.
 *
 * Trust on first use: the first listing is pinned as it is. A server that is
 * poisoned from its first start is not caught here — the sanitizer and the
 * gate still see its descriptions and calls, as for any server. The pins
 * are never replaced by a drifted listing: re-pinning on drift would approve
 * the change by the act of noticing it.
 */
export function comparePins(pinned: Pins | null, listed: readonly ListedTool[]): PinComparison {
  if (pinned === null) {
    const pins: Pins = Object.create(null) as Pins
    for (const tool of listed) pins[tool.name] = fingerprint(tool)
    return { pins, held: [], firstSight: true }
  }

  const held: HeldTool[] = []
  for (const tool of listed) {
    const approved = Object.hasOwn(pinned, tool.name) ? pinned[tool.name] : undefined
    if (approved === undefined) held.push({ name: tool.name, why: 'new' })
    else if (approved !== fingerprint(tool)) held.push({ name: tool.name, why: 'changed' })
  }
  return { pins: pinned, held, firstSight: false }
}

/** JSON with object keys sorted at every depth. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
