import { mkdtempSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * Codex, third review, reproduced: `take` saw the question, another process
 * retired it, an `approve` already under way wrote its late approval, and
 * `take` consumed that approval and let the call through with no question
 * behind it. The interleaving is forced here by running the other two
 * processes' steps at the moment `take` touches the approval file.
 */

let interleave: (() => void) | null = null

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  const at = (path: unknown): void => {
    if (interleave !== null && String(path).endsWith('.approved')) {
      const step = interleave
      interleave = null
      step()
    }
  }
  return {
    ...real,
    unlinkSync: (path: fs.PathLike) => {
      at(path)
      real.unlinkSync(path)
    },
    writeFileSync: (path: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
      real.writeFileSync(path, data, options)
      at(path)
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      at(from)
      real.renameSync(from, to)
    },
  }
})

const { ApprovalStore } = await import('../../src/session/approvals.js')

describe('take against a retirement and a late approval', () => {
  it('an approval written after its question was retired is not taken', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const store = new ApprovalStore(home)
    const id = 'ab'.repeat(8)
    const binding = 'ab'.repeat(32)
    store.request(id, { tool: 'send_email', reason: 'r', args: {}, binding })
    expect(store.approve(id)).not.toBeNull()
    interleave = () => {
      // Another process retires the question and its approval...
      fs.rmSync(store.pendingPath(id), { force: true })
      fs.rmSync(store.approvedPath(id), { force: true })
      // ...and an approve that read the question before that writes late.
      writeFileSync(store.approvedPath(id), binding)
    }
    expect(store.take(id, binding).taken).toBe(false)
  })
})

describe('approve against a take', () => {
  it('an approval taken the moment it was written was given, not lapsed', () => {
    // Codex, fourth review: the question gone after the write read as a
    // retirement, and the owner was told nothing was approved while the call
    // had already run on it.
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const store = new ApprovalStore(home)
    const id = 'cd'.repeat(8)
    const binding = 'cd'.repeat(32)
    store.request(id, { tool: 'send_email', reason: 'r', args: {}, binding })
    let taken = false
    interleave = () => {
      taken = store.take(id, binding).taken
    }
    expect(store.approve(id)).not.toBeNull()
    expect(taken).toBe(true)
  })

  it('the mark of an earlier take does not answer for a later approval', () => {
    // Codex, fifth review: a mark shared by every question under one id let
    // an approval retired mid-write read as taken.
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const store = new ApprovalStore(home)
    const id = 'ce'.repeat(8)
    const binding = 'ce'.repeat(32)
    store.request(id, { tool: 'send_email', reason: 'r', args: {}, binding })
    const asked = fs.readFileSync(store.pendingPath(id), 'utf8')
    store.approve(id)
    expect(store.take(id, binding).taken).toBe(true)
    // The same question asked again, caught between writing its file and
    // clearing anything left from before.
    writeFileSync(store.pendingPath(id), asked)
    interleave = () => {
      fs.rmSync(store.pendingPath(id), { force: true })
      fs.rmSync(store.approvedPath(id), { force: true })
    }
    expect(store.approve(id)).toBeNull()
  })
})

