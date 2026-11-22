import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

let duringWrite: (() => void) | null = null

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    writeFileSync: (path: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
      if (duringWrite === null || typeof path !== 'string' || !path.includes('.request')) {
        real.writeFileSync(path, data, options)
        return
      }
      real.writeFileSync(path, data.slice(0, 2), options)
      const observe = duringWrite
      duringWrite = null
      observe()
      real.appendFileSync(path, data.slice(2))
    },
  }
})

const { APPROVAL_TTL_MS, ApprovalStore } = await import('../../src/session/approvals.js')

describe('ApprovalStore: request publication', () => {
  it('keeps a partly written request invisible until its full body is on disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approvals-'))
    const store = new ApprovalStore(home)
    const id = 'ab'.repeat(8)
    let visibleDuringWrite = true
    duringWrite = () => {
      visibleDuringWrite = existsSync(store.pendingPath(id))
    }
    store.request(id, { tool: 'send_email', reason: 'review', args: { body: 'message' } })
    expect(visibleDuringWrite).toBe(false)
    expect(store.waiting(id)).toMatchObject({ tool: 'send_email', reason: 'review' })
  })

  it('keeps the first question under an ID and removes both temporary files', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approvals-'))
    const store = new ApprovalStore(home)
    const id = 'ab'.repeat(8)
    store.request(id, { tool: 'send_email', reason: 'first' })
    store.request(id, { tool: 'send_email', reason: 'second' })
    expect(store.waiting(id)?.reason).toBe('first')
    expect(readdirSync(join(home, 'approvals'))).toEqual([`${id}.request.json`])
  })

  it('sweeps a temporary request left by a crashed writer after its lifetime', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approvals-'))
    const store = new ApprovalStore(home)
    const old = 'ab'.repeat(8)
    store.request(old, { tool: 'send_email', reason: 'old' })
    const leftover = join(home, 'approvals', `${old}.request-writing.${'cd'.repeat(8)}`)
    writeFileSync(leftover, '{', { mode: 0o600 })
    const past = new Date(Date.now() - APPROVAL_TTL_MS - 1000)
    utimesSync(leftover, past, past)
    store.request('ef'.repeat(8), { tool: 'send_email', reason: 'fresh' })
    expect(existsSync(leftover)).toBe(false)
  })
})
