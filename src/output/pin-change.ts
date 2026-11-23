import { canonical } from '../core/canonical.js'
import type { PinChange } from '../session/pins.js'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only generated line breaks reach the terminal. The path and both values are server-authored. */
export function renderPinChange(change: PinChange, visible: (text: string) => string): string {
  const quoted = (value: unknown) => visible(canonical(value))
  const kind = change.beforeHash === null ? 'new' : 'changed'
  const lines = [
    `${change.id} ${kind} ${quoted(change.after.name)}`,
    `    server argv: ${quoted(change.command)}`,
  ]
  if (!change.before && change.beforeHash !== null) {
    lines.push(`    previous declaration unavailable (SHA-256 ${visible(change.beforeHash)})`)
  }

  function diff(path: string, before: unknown, after: unknown): void {
    if (object(before) && object(after)) {
      for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        const child = path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')
        diff(child, Object.hasOwn(before, key) ? before[key] : undefined, Object.hasOwn(after, key) ? after[key] : undefined)
      }
      return
    }
    if (canonical(before) === canonical(after)) return
    if (before !== undefined) lines.push(`    - ${quoted(path)} ${quoted(before)}`)
    if (after !== undefined) lines.push(`    + ${quoted(path)} ${quoted(after)}`)
  }
  diff('', change.before, change.after)
  return lines.join('\n')
}
