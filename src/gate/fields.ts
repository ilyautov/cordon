/** Limits on walking the arguments. Exceeding them is a refusal, not a truncated walk. */
const MAX_FIELDS = 2000
const MAX_DEPTH = 8

export interface Field {
  /** Name of the nearest object field. An array element inherits its field's name. */
  key: string
  value: unknown
  depth: number
}

/**
 * Flattens the arguments into a list of fields.
 *
 * Without descending, a tainted string inside `{payload: {note: "…"}}` is
 * invisible to both axes: provenance only looks at strings, and the string
 * sits one level down. MCP tools accept nested objects all the time, so this
 * is not exotic but an ordinary call.
 */
export function fields(args: Record<string, unknown>): Field[] {
  const out: Field[] = []

  const visit = (key: string, node: unknown, depth: number): void => {
    if (out.length >= MAX_FIELDS) throw new Error('the call arguments branch too widely')
    if (depth > MAX_DEPTH) throw new Error('the call arguments are too deep')
    out.push({ key, value: node, depth })
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(key, item, depth + 1)
      return
    }
    for (const [name, value] of Object.entries(node)) visit(name, value, depth + 1)
  }

  for (const [key, value] of Object.entries(args)) visit(key, value, 0)
  return out
}
