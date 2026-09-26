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
  /**
   * `changed`: the approved tool now reads differently. `new`: it was not
   * there when approved. `shadow`: its name imitates another server's tool.
   */
  why: 'changed' | 'new' | 'shadow'
  /** For a shadow: the name it imitates. */
  imitates?: string
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

/**
 * Letters that read as Latin ones, mapped to the Latin letter they imitate,
 * plus the digits and the capital that pass for l and o. Not a full
 * confusables table: the Cyrillic and Greek lookalikes are what the
 * mixed-script attacks are made of, and a name only has to fool a glance.
 */
const LOOKALIKE: ReadonlyMap<string, string> = new Map([
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u043e', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0443', 'y'], ['\u0445', 'x'], ['\u0456', 'i'], ['\u0458', 'j'], ['\u0455', 's'], ['\u04bb', 'h'], ['\u0501', 'd'], ['\u051b', 'q'], ['\u051d', 'w'], ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041a', 'K'], ['\u041c', 'M'], ['\u041d', 'H'], ['\u041e', 'O'], ['\u0420', 'P'], ['\u0421', 'C'], ['\u0422', 'T'], ['\u0425', 'X'], ['\u0406', 'I'], ['\u0408', 'J'], ['\u0405', 'S'], ['\u03b1', 'a'], ['\u03bf', 'o'], ['\u03c1', 'p'], ['\u03bd', 'v'], ['\u03b9', 'i'], ['\u03ba', 'k'], ['\u03c5', 'u'], ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'], ['\u0397', 'H'], ['\u0399', 'I'], ['\u039a', 'K'], ['\u039c', 'M'], ['\u039d', 'N'], ['\u039f', 'O'], ['\u03a1', 'P'], ['\u03a4', 'T'], ['\u03a5', 'Y'], ['\u03a7', 'X'],
  // Latin letters outside ASCII that NFKC leaves alone, Armenian and Cherokee:
  // an outside review named script g, Armenian vo and se as passing.
  ['\u0261', 'g'], ['\u0251', 'a'], ['\u0269', 'i'], ['\u0131', 'i'], ['\u0237', 'j'],
  ['\u0578', 'n'], ['\u057d', 'u'], ['\u0570', 'h'], ['\u0581', 'g'], ['\u0585', 'o'],
  ['\u13a0', 'D'], ['\u13a2', 'T'], ['\u13aa', 'A'], ['\u13ac', 'E'], ['\u13b3', 'W'], ['\u13bb', 'H'], ['\u13da', 'S'], ['\u13df', 'C'],
  ['0', 'o'], ['1', 'l'], ['I', 'l'],
])

/**
 * Characters that render as nothing: zero-width spaces and joiners, soft
 * hyphens, variation selectors. NFKC keeps them, and read_fi<ZWSP>le reads as
 * read_file in every host.
 */
const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

/**
 * A tool name as it reads at a glance. Case and separators are kept: two
 * honest servers choose read_file and readFile, and only a lookalike
 * character is an imitation.
 */
export function skeleton(name: string): string {
  let out = ''
  for (const char of name.normalize('NFKC').replace(IGNORABLE, '')) {
    // Twice: Greek and Cyrillic capital I map to I, and I itself reads as l.
    const once = LOOKALIKE.get(char) ?? char
    out += LOOKALIKE.get(once) ?? once
  }
  return out
}

/** A name with nothing in it that passes for something else. */
function plain(name: string): boolean {
  return skeleton(name) === name
}

export interface Shadow {
  name: string
  imitates: string
  server: string
}

/**
 * Tools whose name reads as another server's tool and is not it: `re\u0430d_file`
 * next to a pinned `read_file`. A host that routes by name, or a model that
 * picks by name, calls the imitation. The same name on two servers is not a
 * shadow: search and read_file exist on many servers, and holding them would
 * break honest setups.
 */
export function shadows(
  listed: readonly ListedTool[],
  others: ReadonlyArray<{ server: string; names: readonly string[] }>,
): Shadow[] {
  const found: Shadow[] = []
  for (const tool of listed) {
    const own = skeleton(tool.name)
    for (const other of others) {
      // The plain side of a pair is not the imitation. Otherwise an imitating
      // server pinned first would take the honest server's read_file away on
      // every start, for good; its own gateway meets the honest pin instead.
      const imitated = other.names.find(
        (name) => name !== tool.name && skeleton(name) === own && !(plain(tool.name) && !plain(name)),
      )
      if (imitated !== undefined) {
        found.push({ name: tool.name, imitates: imitated, server: other.server })
        break
      }
    }
  }
  return found
}
