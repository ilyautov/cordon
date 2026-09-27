import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cordon } from '../src/cordon.js'
import { DEFAULT_POLICY, type Policy } from '../src/policy/defaults.js'

/**
 * A budget caps what an unattended agent can do however it was steered: a
 * call over it is refused whatever else allowed it, in either mode, and no
 * approval lifts it (Codex: a budget is not a question to put to anyone).
 */

function make(home: string, overrides: Partial<Policy> = {}, sessionId = 's1') {
  const policy: Policy = structuredClone(DEFAULT_POLICY)
  policy.mode = 'autonomous'
  policy.profile = { effects: ['read', 'create'], resources: { paths: [], hosts: [] } }
  policy.tools = { post_note: ['create'] }
  policy.budgets = [{ effect: 'create', limit: 2, per: 'hour' }]
  policy.notify = { file: join(home, 'events.jsonl') }
  return new Cordon({ policy: { ...policy, ...overrides }, cordonHome: home, sessionId })
}

const NOTE = { tool: 'post_note', args: { text: 'weekly summary' } }

describe('budgets', () => {
  it('refuses the call past the limit, with the rule budget', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const cordon = make(home)
    expect(cordon.gate(NOTE).kind).toBe('allow')
    expect(cordon.gate(NOTE).kind).toBe('allow')
    const third = cordon.gate(NOTE)
    expect(third.kind).toBe('deny')
    expect(third.kind === 'deny' && third.rule).toBe('budget')
    expect(third.kind === 'deny' && third.reason).toMatch(/2 of 2 per hour/)
  })

  it('a new session does not get a new budget', () => {
    // An agent that restarts itself gets a new session id (Kimi).
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    make(home, {}, 'a').gate(NOTE)
    make(home, {}, 'b').gate(NOTE)
    expect(make(home, {}, 'c').gate(NOTE).kind).toBe('deny')
  })

  it('interactive mode refuses too, and offers no approval', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const cordon = make(home, { mode: 'interactive' })
    cordon.gate(NOTE)
    cordon.gate(NOTE)
    const over = cordon.gateUnattended(NOTE)
    expect(over.kind).toBe('deny')
    expect(over.kind === 'deny' && over.reason).not.toMatch(/cordon approve/)
  })

  it('a call refused for another reason spends nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const cordon = make(home)
    cordon.observe('post this', { id: 'p', kind: 'web', label: 'https://evil.example', trust: 'untrusted' })
    for (let i = 0; i < 5; i++) expect(cordon.gate(NOTE).kind).toBe('deny')
    cordon.onUserPrompt('post the weekly summary')
    expect(make(home).gate(NOTE).kind).toBe('allow')
  })

  it('an effect without a budget is not counted', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    const cordon = make(home)
    for (let i = 0; i < 5; i++) expect(cordon.gate({ tool: 'Read', args: { file_path: '/tmp/x' } }).kind).toBe('allow')
  })

  it('a budget that cannot be counted refuses, loudly', () => {
    const home = mkdtempSync(join(tmpdir(), 'cordon-home-'))
    writeFileSync(join(home, 'budgets'), 'not a directory')
    const cordon = make(home)
    const decision = cordon.gate(NOTE)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.rule).toBe('failure')
    expect(readFileSync(join(home, 'events.jsonl'), 'utf8')).toMatch(/budget/)
  })
})
