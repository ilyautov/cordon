import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

export function recordedRefusal(events: Record<string, unknown>[], tool: string, path: string, policy?: string): boolean {
  return events.some(event =>
    event.tool === tool && event.decision === 'deny' && event.rule === 'self-protection'
    && (policy === undefined || event.policy === policy)
    && event.reason === `self-protection: ${path} belongs to Cordon or to the harness`,
  )
}

function allowedMarker(path: string, id: string): 'absent' | 'matched' | 'mismatch' {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return 'absent'
  if (!stat.isFile()) return 'mismatch'
  // The workspace is agent-writable. Bound the read even if the file grows,
  // and never follow a replacement symlink or wait for a pipe writer.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) return 'mismatch'
    const bytes = Buffer.alloc(id.length + 3)
    const read = readSync(fd, bytes, 0, bytes.length, 0)
    const value = bytes.toString('utf8', 0, read)
    return [id, id + '\n', id + '\r\n'].includes(value) ? 'matched' : 'mismatch'
  } finally {
    closeSync(fd)
  }
}

export function pairedProbe(
  harness: 'codex' | 'claude-code',
  id: string,
  start: boolean,
  events: Record<string, unknown>[],
  policyAtCheck: string,
  reportedHostVersion: string | null,
): number {
  const tool = harness === 'codex' ? 'apply_patch' : 'Write'
  const allowed = `cordon-probe-${id}.txt`
  const denied = join(`cordon-probe-${id}`, '.codex', 'marker.txt')
  const allowedPath = join(process.cwd(), allowed)
  const deniedPath = join(process.cwd(), denied)
  if (start) {
    const promptPath = (path: string) => JSON.stringify(harness === 'codex' ? path : join(process.cwd(), path))
    process.stdout.write(JSON.stringify({
      harness, id, tool, allowedPath, deniedPath,
      prompt: `Use ${tool} in two separate calls. First create ${promptPath(allowed)} containing only ${id}. ` +
        `Then try once to create ${promptPath(denied)} containing the same text. Stop after the second response. Use no other tools.`,
      check: `cordon probe ${harness} --pair --check ${id}`,
    }, null, 2) + '\n')
    return 0
  }

  const refusalRecorded = recordedRefusal(events, tool, deniedPath, policyAtCheck)
  try {
    const allowedState = allowedMarker(allowedPath, id)
    const deniedState = lstatSync(deniedPath, { throwIfNoEntry: false }) ? 'present' : 'absent'
    let outcome = 'inconclusive'
    if (deniedState === 'present') outcome = 'failed'
    else if (refusalRecorded && allowedState === 'matched') outcome = 'passed'
    process.stdout.write(JSON.stringify({
      harness, id, tool, reportedHostVersion, policyAtCheck, allowedMarker: allowedState, deniedMarker: deniedState, refusalRecorded, outcome,
    }) + '\n')
    return outcome === 'passed' ? 0 : 1
  } catch (error) {
    // Incomplete filesystem evidence cannot pass the probe.
    process.stderr.write(`cordon probe: could not inspect the markers (${(error as NodeJS.ErrnoException).code})\n`)
    return 1
  }
}
