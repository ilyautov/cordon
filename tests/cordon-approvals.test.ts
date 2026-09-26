import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cordon } from '../src/cordon.js'
import { DEFAULT_POLICY, type Policy } from '../src/policy/defaults.js'
import { ApprovalStore } from '../src/session/approvals.js'

function make(mode: Policy['mode']) {
  const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
  const log = join(home, 'events.jsonl')
  const policy: Policy = structuredClone(DEFAULT_POLICY)
  policy.mode = mode
  policy.profile = { effects: ['read'], resources: { paths: [], hosts: [] } }
  policy.tools = { send_email: ['network-egress'] }
  policy.notify = { file: log }
  return { cordon: new Cordon({ policy, cordonHome: home, sessionId: 's1' }), home, log }
}

const SEND = { tool: 'send_email', args: { to: 'a@example.com', body: 'the report' } }

function idIn(reason: string): string {
  const match = /cordon approve ([0-9a-f]{16})/u.exec(reason)
  if (match === null) throw new Error(`no approval id in: ${reason}`)
  return match[1]!
}

describe('Cordon.gateUnattended: a question with nobody to ask it', () => {
  it('becomes a refusal that names the one-time approval', () => {
    const { cordon } = make('interactive')
    const decision = cordon.gateUnattended(SEND)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toMatch(/outside the certificate/)
    expect(decision.kind === 'deny' && idIn(decision.reason)).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('tells the owner through the journal, with the id', () => {
    const { cordon, log } = make('interactive')
    const decision = cordon.gateUnattended(SEND)
    const id = idIn(decision.kind === 'deny' ? decision.reason : '')
    expect(readFileSync(log, 'utf8')).toContain(id)
  })

  it('after the owner approves, the same call goes through once', () => {
    const { cordon, home } = make('interactive')
    const first = cordon.gateUnattended(SEND)
    const id = idIn(first.kind === 'deny' ? first.reason : '')
    expect(new ApprovalStore(home).approve(id)).not.toBeNull()
    expect(cordon.gateUnattended(SEND).kind).toBe('allow')
    expect(cordon.gateUnattended(SEND).kind).toBe('deny')
  })

  it('the approval does not carry over to a changed call', () => {
    const { cordon, home } = make('interactive')
    const first = cordon.gateUnattended(SEND)
    new ApprovalStore(home).approve(idIn(first.kind === 'deny' ? first.reason : ''))
    const changed = { ...SEND, args: { ...SEND.args, to: 'attacker@evil.example' } }
    expect(cordon.gateUnattended(changed).kind).toBe('deny')
  })

  it('autonomous mode refuses without offering one: there the policy is the answer', () => {
    const { cordon } = make('autonomous')
    const decision = cordon.gateUnattended(SEND)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).not.toMatch(/cordon approve/)
  })

  it('a call the gate allows is untouched', () => {
    const { cordon } = make('interactive')
    expect(cordon.gateUnattended({ tool: 'Read', args: { file_path: '/tmp/x' } }).kind).toBe('allow')
  })

  it('self-protection is never offered for approval', () => {
    const { cordon, home } = make('interactive')
    const decision = cordon.gateUnattended({ tool: 'Write', args: { file_path: join(home, 'policy.yaml'), content: 'x' } })
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).not.toMatch(/cordon approve/)
  })
})
