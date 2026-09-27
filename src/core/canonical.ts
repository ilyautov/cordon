/** JSON with every object's keys sorted: one spelling per value, for hashing. */
export function canonical(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? ''
}

export function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== 'object' || value === null) return value
  // No prototype: JSON.parse keeps "__proto__" as an own key, and on a plain
  // object the assignment below would set the prototype instead, dropping
  // that subtree from the hash while the upstream still receives it.
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) result[key] = sorted((value as Record<string, unknown>)[key])
  return result
}
