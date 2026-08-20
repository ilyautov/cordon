import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../../src/session/store.js'
import { TaintStore } from '../../src/provenance/store.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'cordon-draft-'))
}

function store(): SessionStore {
  return new SessionStore(home())
}

/** The file name is asked of the store: the naming rule is its business, not the test's. */
function stateName(dir: string, sessionId: string): string {
  new SessionStore(dir).save(sessionId, { turn: 0, taint: new TaintStore() })
  return readdirSync(join(dir, 'sessions'))[0]!
}

function draftName(dir: string, sessionId: string): string {
  new SessionStore(dir).saveDraft(sessionId, { messageId: 'm0', text: 'a trial' })
  return readdirSync(join(dir, 'drafts'))[0]!
}

describe('accumulating the displayed message', () => {
  it('accumulates the deltas of one message across processes', () => {
    const dir = home()
    new SessionStore(dir).saveDraft('s', { messageId: 'm1', text: 'The beginning ' })
    expect(new SessionStore(dir).loadDraft('s')).toEqual({ messageId: 'm1', text: 'The beginning ' })
  })

  it('there is nothing accumulated by default', () => {
    expect(store().loadDraft('s')).toBeUndefined()
  })

  it('the accumulated text is erased', () => {
    const dir = home()
    const disk = new SessionStore(dir)
    disk.saveDraft('s', { messageId: 'm1', text: 'a piece' })
    disk.clearDraft('s')
    expect(disk.loadDraft('s')).toBeUndefined()
  })

  it('having nothing to erase is not an error', () => {
    // A draft decides nothing: a failed erase must not take the footer away.
    expect(() => store().clearDraft('s')).not.toThrow()
  })

  it('different sessions accumulate separately', () => {
    const dir = home()
    const disk = new SessionStore(dir)
    disk.saveDraft('a', { messageId: 'm1', text: 'the first' })
    disk.saveDraft('b', { messageId: 'm1', text: 'the second' })
    expect(disk.loadDraft('a')?.text).toBe('the first')
    expect(disk.loadDraft('b')?.text).toBe('the second')
  })

  it('the accumulated text does not travel with the session state', () => {
    // The property that matters: the state is written whole, and writing the
    // draft into it would overwrite provenance written by a neighbouring hook
    // process.
    const dir = home()
    const disk = new SessionStore(dir)
    const taint = new TaintStore()
    taint.record('Entirely unrelated text from a page that was read about analytics.', {
      id: 'w1', kind: 'web', label: 'https://example.com/a', trust: 'untrusted',
    })
    disk.save('s', { turn: 2, taint })

    const path = join(dir, 'sessions', readdirSync(join(dir, 'sessions'))[0]!)
    const before = statSync(path)
    const body = readFileSync(path, 'utf8')

    disk.saveDraft('s', { messageId: 'm1', text: 'a piece' })
    disk.clearDraft('s')

    const after = statSync(path)
    // The state is written by renaming a temporary file, so a substitution
    // shows up as a changed inode even when the content is the same.
    expect(after.ino).toBe(before.ino)
    expect(readFileSync(path, 'utf8')).toBe(body)
    expect(disk.load('s').turn).toBe(2)
  })

  it('a previous version of the state reads, it simply has nothing accumulated in it', () => {
    // Files of previous versions must be readable: an exception here would
    // turn into a refusal on every call.
    const dir = home()
    const name = stateName(dir, 's')
    writeFileSync(
      join(dir, 'sessions', name),
      JSON.stringify({ version: 3, turn: 1, taint: new TaintStore().toJSON(), unredacted: true }),
    )
    const state = new SessionStore(dir).load('s')
    expect(state.turn).toBe(1)
    expect(state.unredacted).toBe(true)
    expect(new SessionStore(dir).loadDraft('s')).toBeUndefined()
  })

  it('a version 4 state with accumulated text inside reads, the field is simply not read', () => {
    // Such files already lie on disks: the accumulated text once travelled
    // inside the state. Rejecting them would mean fixing a quiet loss with a
    // loud refusal.
    const dir = home()
    const name = stateName(dir, 's')
    writeFileSync(
      join(dir, 'sessions', name),
      JSON.stringify({
        version: 4,
        turn: 5,
        taint: new TaintStore().toJSON(),
        unredacted: true,
        directive: ['read'],
        draft: { messageId: 'm1', text: 'the old accumulated text' },
      }),
    )
    const state = new SessionStore(dir).load('s')
    expect(state.turn).toBe(5)
    expect(state.unredacted).toBe(true)
    expect(state.directive).toEqual(['read'])
    expect(new SessionStore(dir).loadDraft('s')).toBeUndefined()
  })

  it('the accumulated text does not grow without limit', () => {
    const dir = home()
    const disk = new SessionStore(dir)
    disk.saveDraft('s', { messageId: 'm1', text: 'a'.repeat(1_000_000) })
    expect(disk.loadDraft('s')?.text.length ?? 0).toBeLessThanOrEqual(200_000)
  })

  it('a malformed draft does not bring the read down', () => {
    // An empty message identifier means "nothing was accumulated". Throwing
    // here is not allowed: an exception in the display hook would cost the
    // human the sight of the answer.
    const dir = home()
    const disk = new SessionStore(dir)
    disk.saveDraft('s', { messageId: '', text: 'junk' })
    expect(disk.loadDraft('s')).toBeUndefined()
  })

  it('an accumulated draft of the wrong shape in the file is the absence of a draft, not a refusal', () => {
    const dir = home()
    const name = draftName(dir, 's')
    const broken: unknown[] = ['a string', 42, [], { messageId: 'm1' }, { text: 'no identifier' }, null]
    for (const value of broken) {
      writeFileSync(join(dir, 'drafts', name), JSON.stringify(value))
      expect(new SessionStore(dir).loadDraft('s')).toBeUndefined()
    }
  })

  it('an unreadable draft is the absence of a draft, not a refusal', () => {
    const dir = home()
    const name = draftName(dir, 's')
    writeFileSync(join(dir, 'drafts', name), '{ this is not json')
    expect(() => new SessionStore(dir).loadDraft('s')).not.toThrow()
    expect(new SessionStore(dir).loadDraft('s')).toBeUndefined()
  })

  it('the draft fields are read only as own properties', () => {
    // The names come from the file, that is, from outside: a lookup through
    // the prototype would return a member of Object.prototype instead of an
    // absent field.
    const dir = home()
    const name = draftName(dir, 's')
    writeFileSync(join(dir, 'drafts', name), '{"__proto__":{"messageId":"m1","text":"a forgery"}}')
    expect(new SessionStore(dir).loadDraft('s')).toBeUndefined()
  })
})

// The session identifier comes from the harness, that is, from outside, and
// is substituted into the draft file path exactly as into the state file
// path.
describe('the draft: the session identifier comes from outside', () => {
  const evil: ReadonlyArray<readonly [string, string]> = [
    ['an empty identifier', ''],
    ['a step upwards', '../../policy'],
    ['an absolute path', '/etc/passwd'],
    ['a unix separator', 'a/b/c'],
    ['a windows separator', 'a\\b\\c'],
    ['leading dots', '...hidden'],
    ['a very long one', 'x'.repeat(5000)],
    ['the name of someone else\'s file', 'policy.yaml'],
  ]

  for (const [title, id] of evil) {
    it(`${title}: the file stays inside drafts and does not touch the config`, () => {
      const dir = home()
      writeFileSync(join(dir, 'policy.yaml'), 'mode: autonomous\n')
      const disk = new SessionStore(dir)
      disk.saveDraft(id, { messageId: 'm1', text: 'a piece' })

      const files = readdirSync(join(dir, 'drafts'))
      expect(files.length).toBe(1)
      const name = files[0]!
      expect(name).not.toContain('..')
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(name.startsWith('.')).toBe(false)
      expect(name.length).toBeLessThanOrEqual(160)
      expect(readdirSync(dir).sort()).toEqual(['drafts', 'policy.yaml'])
      expect(readFileSync(join(dir, 'policy.yaml'), 'utf8')).toBe('mode: autonomous\n')
      expect(disk.loadDraft(id)?.text).toBe('a piece')
    })
  }

  it('identifiers that differ only by a filtered character do not merge', () => {
    const dir = home()
    const disk = new SessionStore(dir)
    disk.saveDraft('a/b', { messageId: 'm1', text: 'the first' })
    disk.saveDraft('a_b', { messageId: 'm1', text: 'the second' })
    expect(disk.loadDraft('a/b')?.text).toBe('the first')
    expect(disk.loadDraft('a_b')?.text).toBe('the second')
  })

  it('erasing one session does not touch what another has accumulated', () => {
    const dir = home()
    const disk = new SessionStore(dir)
    disk.saveDraft('a/b', { messageId: 'm1', text: 'the first' })
    disk.saveDraft('a_b', { messageId: 'm1', text: 'the second' })
    disk.clearDraft('a/b')
    expect(disk.loadDraft('a/b')).toBeUndefined()
    expect(disk.loadDraft('a_b')?.text).toBe('the second')
    expect(existsSync(join(dir, 'policy.yaml'))).toBe(false)
  })
})
