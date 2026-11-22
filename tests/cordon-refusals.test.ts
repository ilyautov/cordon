import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cordon } from '../src/cordon.js'
import { DEFAULT_POLICY, type Policy } from '../src/policy/defaults.js'
import { ApprovalStore } from '../src/session/approvals.js'

// NVIDIA, on agents that escaped their test environments: drift starts where
// an agent is blocked and goes looking for another way to the same end. A
// refused call is exactly that point, so after a few refusals in one turn
// every call that acts goes back to the human until they write again.

function make(mode: Policy['mode'], refusals?: number, effects: Policy['profile']['effects'] = ['read', 'create']) {
  const home = mkdtempSync(join(tmpdir(), 'cordon-refusals-'))
  const log = join(home, 'events.jsonl')
  const policy: Policy = structuredClone(DEFAULT_POLICY)
  policy.mode = mode
  policy.profile = { effects, resources: { paths: [], hosts: [] } }
  policy.tools = { read_file: ['read'], write_file: ['create'], delete_file: ['delete'] }
  policy.notify = { file: log }
  if (refusals !== undefined) policy.refusals = refusals
  const open = () => new Cordon({ policy, cordonHome: home, sessionId: 's1' })
  return { open, home, log }
}

const DELETE = { tool: 'delete_file', args: { path: '/w/a.txt' } }
const WRITE = { tool: 'write_file', args: { path: '/w/notes.txt', content: 'x' } }
const READ = { tool: 'read_file', args: { path: '/w/b.txt' } }

describe('refusals in one turn', () => {
  it('under the limit, the agent works on', () => {
    const { open } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    cordon.gate(DELETE)
    cordon.gate(DELETE)
    expect(cordon.gate(WRITE).kind).toBe('allow')
  })

  it('at the limit, a call that acts is held and reading goes on', () => {
    const { open } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    for (let i = 0; i < 3; i++) expect(cordon.gate(DELETE).kind).toBe('deny')
    const held = cordon.gate(WRITE)
    expect(held.kind).toBe('deny')
    expect(held.kind === 'deny' && held.rule).toBe('refusals')
    expect(cordon.gate(READ).kind).toBe('allow')
  })

  it('the count lives in the session, not in one process', () => {
    const { open } = make('autonomous')
    open().onUserPrompt('tidy up the notes')
    for (let i = 0; i < 3; i++) open().gate(DELETE)
    expect(open().gate(WRITE).kind).toBe('deny')
  })

  it('the human writing again lifts it', () => {
    const { open } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    for (let i = 0; i < 3; i++) cordon.gate(DELETE)
    cordon.onUserPrompt('fine, just write the notes')
    expect(cordon.gate(WRITE).kind).toBe('allow')
  })

  it('in interactive mode the held call is a question', () => {
    const { open } = make('interactive')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    // A question the human answers is not a refusal the agent meets.
    for (let i = 0; i < 3; i++) expect(cordon.gate(DELETE).kind).toBe('ask')
    expect(cordon.gate(WRITE).kind).toBe('allow')
  })

  it('with nobody to ask, the held call names a one-time approval, and it is honoured', () => {
    // The approval route is how honest work proceeds on Codex, Kimi and MCP;
    // a hold that refused it outright would deadlock the owner too.
    const { open, home } = make('interactive')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    for (let i = 0; i < 3; i++) expect(cordon.gateUnattended(DELETE).kind).toBe('deny')
    const held = cordon.gateUnattended(WRITE)
    expect(held.kind === 'deny' && held.rule).toBe('refusals')
    const id = /cordon approve ([0-9a-f]{16})/u.exec(held.kind === 'deny' ? held.reason : '')![1]!
    new ApprovalStore(home).approve(id)
    expect(cordon.gateUnattended(WRITE).kind).toBe('allow')
  })

  it('the owner\'s journal says when the hold began', () => {
    const { open, log } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    for (let i = 0; i < 3; i++) cordon.gate(DELETE)
    const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(events.filter((event) => event.decision === 'refusals-hold')).toHaveLength(1)
  })

  it('refusals: 0 turns it off', () => {
    const { open } = make('autonomous', 0)
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    for (let i = 0; i < 5; i++) cordon.gate(DELETE)
    expect(cordon.gate(WRITE).kind).toBe('allow')
  })
})

describe('what a refusal tells the agent', () => {
  // A refusal that only explains invites the agent to route around it. It
  // says what to do instead: stop, and tell the human.
  it('every refusal the agent meets says to stop and tell the user', () => {
    const { open } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    const refused = cordon.gate(DELETE)
    expect(refused.kind === 'deny' && refused.reason).toMatch(/do not try another way to the same end; tell the user/i)
  })

  it('a refusal naming a one-time approval says it too, and still says the retry', () => {
    const { open } = make('interactive')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    const refused = cordon.gateUnattended(DELETE)
    const reason = refused.kind === 'deny' ? refused.reason : ''
    expect(reason).toMatch(/cordon approve [0-9a-f]{16}/)
    expect(reason).toMatch(/do not try another way to the same end/i)
  })

  it('the owner\'s journal keeps the reason without it', () => {
    const { open, log } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    cordon.gate(DELETE)
    expect(readFileSync(log, 'utf8')).not.toMatch(/another way to the same end/i)
  })
})

describe('the hold never weakens a cut', () => {
  // Review of the hold: a rewrite under it became a question filed under
  // refusals, with no source, and an approval ran the call with its
  // original arguments, the untrusted fragment back in. The cut is a
  // protection; where it cannot be applied, the call is judged whole under
  // the rule that found the fragment, as a shell command is.
  const REVIEW = 'The delivery was slower than promised and the packaging arrived slightly crushed on one corner.'
  const NOTE = '/w/feedback.txt'
  const WRITE_QUOTING = { tool: 'Write', args: { file_path: NOTE, content: `A note.\n${REVIEW}\nend` } }

  function primed(mode: Policy['mode']) {
    // Write is create and update; the hold's own fixture grants create alone.
    const made = make(mode, undefined, ['read', 'create', 'update'])
    const cordon = made.open()
    cordon.onUserPrompt(`write a note about the feedback to ${NOTE}`)
    cordon.observe(REVIEW, { id: 'r1', kind: 'tool', label: 'wb_reviews', trust: 'untrusted' })
    expect(cordon.gate(WRITE_QUOTING).kind).toBe('rewrite')
    return { ...made, cordon }
  }

  it('a rewrite under the hold is a question under its own rule, naming the source', () => {
    const { cordon } = primed('interactive')
    for (let i = 0; i < 3; i++) expect(cordon.gateUnattended(DELETE).kind).toBe('deny')
    const held = cordon.gate(WRITE_QUOTING)
    expect(held.kind).toBe('ask')
    expect(held.kind === 'ask' && held.rule).toBe('provenance')
    expect(held.kind === 'ask' && held.source).toBe('wb_reviews')
    expect(held.kind === 'ask' && held.reason).toMatch(/untrusted fragment/u)
    expect(held.kind === 'ask' && held.reason).toMatch(/refused since your last message/u)
  })

  it('with nobody to ask, the refusal keeps the rule and the source too', () => {
    const { cordon } = primed('interactive')
    for (let i = 0; i < 3; i++) cordon.gateUnattended(DELETE)
    const held = cordon.gateUnattended(WRITE_QUOTING)
    expect(held.kind).toBe('deny')
    expect(held.kind === 'deny' && held.rule).toBe('provenance')
    expect(held.kind === 'deny' && held.source).toBe('wb_reviews')
    expect(held.kind === 'deny' && held.reason).toMatch(/cordon approve [0-9a-f]{16}/u)
  })

  it('in autonomous mode the rewrite under the hold is refused under its own rule', () => {
    const { cordon } = primed('autonomous')
    for (let i = 0; i < 3; i++) cordon.gate(DELETE)
    const held = cordon.gate(WRITE_QUOTING)
    expect(held.kind).toBe('deny')
    expect(held.kind === 'deny' && held.rule).toBe('provenance')
  })
})

describe('the hold never weakens a more specific refusal', () => {
  // Review of 746c535: the hold ran before every other rule, so a call the
  // certificate or provenance would have refused was filed under refusals,
  // with a precaution tier and no source, and the agent was never told why.
  it('a call outside the certificate keeps its own rule under the hold', () => {
    const { open } = make('autonomous')
    const cordon = open()
    cordon.onUserPrompt('tidy up the notes')
    for (let i = 0; i < 3; i++) cordon.gate(DELETE)
    const again = cordon.gate(DELETE)
    expect(again.kind === 'deny' && again.rule).toBe('certificate')
  })
})

describe('the owner hears when the hold begins, however the count got there', () => {
  it('three hooks that each saw a count of one: the next one to look sends the alert', () => {
    const { open, log } = make('autonomous')
    open().onUserPrompt('tidy up the notes')
    const parallel = [open(), open(), open()]
    // Each writes its piece without having seen the others.
    for (const cordon of parallel) cordon.gate(DELETE)
    const events = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    open().gate(DELETE)
    expect(events().filter((event) => event.decision === 'refusals-hold')).toHaveLength(1)
    open().gate(DELETE)
    expect(events().filter((event) => event.decision === 'refusals-hold')).toHaveLength(1)
  })

  it('refusals written by parallel hooks still raise the alert once the count crosses the limit', () => {
    // Review of 746c535: three hooks refusing at once each saw a count of
    // one, and the next saw four; an alert on exactly three never fired.
    const { open, log } = make('autonomous')
    open().onUserPrompt('tidy up the notes')
    const parallel = [open(), open(), open()]
    for (const cordon of parallel) cordon.gate(DELETE)
    open().gate(DELETE)
    const events = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(events.filter((event) => event.decision === 'refusals-hold').length).toBeGreaterThanOrEqual(1)
  })
})
