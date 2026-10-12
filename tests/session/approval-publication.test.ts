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
      if (duringWrite === null || typeof path !== 'string' ||
        !(path.endsWith('.approved') || path.includes('.approval-writing.'))) {
        real.writeFileSync(path, data, options)
        return
      }
      // The binding is complete, but the nonce has not been written yet.
      const cut = data.lastIndexOf('\n') + 1
      real.writeFileSync(path, data.slice(0, cut), options)
      const observe = duringWrite
      duringWrite = null
      observe()
      real.appendFileSync(path, data.slice(cut))
    },
  }
})

const { APPROVAL_TTL_MS, ApprovalStore } = await import('../../src/session/approvals.js')

describe('ApprovalStore: approval publication', () => {
  it('does not let a retry take a partly written owner approval', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approvals-'))
    const store = new ApprovalStore(home)
    const id = 'ab'.repeat(8)
    const binding = 'ab'.repeat(32)
    store.request(id, { tool: 'send_email', reason: 'review', binding })
    let takenDuringWrite = false
    duringWrite = () => {
      takenDuringWrite = store.take(id, binding).taken
    }
    const shown = store.approve(id)
    expect(takenDuringWrite).toBe(false)
    expect(shown).not.toBeNull()
    expect(store.take(id, binding).taken).toBe(true)
  })

  it('replaces an earlier complete approval and leaves no writing files', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approvals-'))
    const store = new ApprovalStore(home)
    const id = 'ab'.repeat(8)
    const binding = 'ab'.repeat(32)
    store.request(id, { tool: 'send_email', reason: 'review', binding })
    expect(store.approve(id)).not.toBeNull()
    expect(store.approve(id)).not.toBeNull()
    expect(readdirSync(join(home, 'approvals')).sort()).toEqual([`${id}.approved`, `${id}.request.json`])
    expect(store.take(id, binding).taken).toBe(true)
    expect(store.take(id, binding).taken).toBe(false)
  })

  it('sweeps a private approval file left by a crashed writer', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-approvals-'))
    const store = new ApprovalStore(home)
    const old = 'ab'.repeat(8)
    store.request(old, { tool: 'send_email', reason: 'old' })
    const leftover = join(home, 'approvals', `${old}.approval-writing.${'cd'.repeat(8)}`)
    writeFileSync(leftover, '{', { mode: 0o600 })
    const past = new Date(Date.now() - APPROVAL_TTL_MS - 1000)
    utimesSync(leftover, past, past)
    store.request('ef'.repeat(8), { tool: 'send_email', reason: 'fresh' })
    expect(existsSync(leftover)).toBe(false)
  })
})
