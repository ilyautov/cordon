import { mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APPROVAL_TTL_MS, ApprovalStore, approvalId } from '../../src/session/approvals.js'

function store() {
  return new ApprovalStore(mkdtempSync(join(tmpdir(), 'cordon-approvals-')))
}

const CALL = { tool: 'send_email', args: { to: 'a@example.com', body: 'hi' } }

describe('approvalId: bound to the exact call', () => {
  it('the same call in the same session has the same id, whatever the key order', () => {
    expect(approvalId('s', CALL)).toBe(approvalId('s', { tool: 'send_email', args: { body: 'hi', to: 'a@example.com' } }))
    expect(approvalId('s', CALL)).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('a changed argument, tool or session is a different id', () => {
    const id = approvalId('s', CALL)
    expect(approvalId('s', { ...CALL, args: { ...CALL.args, to: 'b@example.com' } })).not.toBe(id)
    expect(approvalId('s', { ...CALL, tool: 'send_mail' })).not.toBe(id)
    expect(approvalId('t', CALL)).not.toBe(id)
  })

  it('nesting cannot be forged by joining strings', () => {
    expect(approvalId('s', { tool: 'x', args: { a: { b: 1 } } })).not.toBe(approvalId('s', { tool: 'x', args: { 'a.b': 1 } }))
  })
})

describe('ApprovalStore: one approval, one call', () => {
  it('an approval the owner never gave is not consumed', () => {
    const approvals = store()
    const id = approvalId('s', CALL)
    approvals.request(id, { tool: CALL.tool, reason: 'r' })
    expect(approvals.consume(id)).toBe(false)
  })

  it('an approved request passes once, and only once', () => {
    const approvals = store()
    const id = approvalId('s', CALL)
    approvals.request(id, { tool: CALL.tool, reason: 'r' })
    expect(approvals.approve(id)).toMatchObject({ tool: 'send_email', reason: 'r' })
    expect(approvals.consume(id)).toBe(true)
    expect(approvals.consume(id)).toBe(false)
  })

  it('nothing to approve without a pending request', () => {
    expect(store().approve('0123456789abcdef')).toBeNull()
  })

  it('an id that is not one is refused before it touches the disk', () => {
    const approvals = store()
    expect(() => approvals.approve('../../policy')).toThrow(/not an approval id/)
    expect(approvals.consume('../x')).toBe(false)
  })

  it('an approval older than its lifetime is not honoured', () => {
    const approvals = store()
    const id = approvalId('s', CALL)
    approvals.request(id, { tool: CALL.tool, reason: 'r' })
    approvals.approve(id)
    const old = new Date(Date.now() - APPROVAL_TTL_MS - 1000)
    utimesSync(approvals.approvedPath(id), old, old)
    expect(approvals.consume(id)).toBe(false)
  })

  it('a request older than its lifetime cannot be approved', () => {
    const approvals = store()
    const id = approvalId('s', CALL)
    approvals.request(id, { tool: CALL.tool, reason: 'r' })
    const old = new Date(Date.now() - APPROVAL_TTL_MS - 1000)
    utimesSync(approvals.pendingPath(id), old, old)
    expect(approvals.approve(id)).toBeNull()
  })

  it('lists the pending requests for the owner', () => {
    const approvals = store()
    const id = approvalId('s', CALL)
    approvals.request(id, { tool: CALL.tool, reason: 'r' })
    expect(approvals.pending()).toEqual([expect.objectContaining({ id, tool: 'send_email', reason: 'r' })])
  })
})
