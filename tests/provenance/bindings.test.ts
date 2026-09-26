import { describe, expect, it } from 'vitest'
import { readLookup, vouched, vouchKey, type Observation } from '../../src/provenance/bindings.js'
import type { Lookup } from '../../src/policy/defaults.js'

/** A lookup result that must have been readable. */
function read(...args: Parameters<typeof readLookup>): Observation[] {
  const found = readLookup(...args)
  if (found === 'unreadable') throw new Error('unreadable')
  return found
}

const contacts: Lookup = {
  query: 'query',
  key: 'name',
  values: { email: ['send_email.recipients', 'create_calendar_event.participants'] },
}
const calendar: Lookup = {
  query: 'query',
  key: 'title',
  values: { participants: ['create_calendar_event.participants'], id_: ['reschedule_calendar_event.event_id'] },
}

describe('reading a lookup result', () => {
  it('reads a YAML list of records, as AgentDojo prints them', () => {
    const text = '- email: sarah.baker@gmail.com\n  name: Sarah Baker\n'
    expect(readLookup('contacts', contacts, { query: 'Sarah Baker' }, text, 1)).toEqual([
      { tool: 'contacts', field: 'email', key: 'sarah baker', values: ['sarah.baker@gmail.com'], query: 'sarah baker', turn: 1 },
    ])
  })

  it('reads JSON and a single record', () => {
    const text = JSON.stringify({ name: 'Sarah Baker', email: 'sarah.baker@gmail.com' })
    expect(read('contacts', contacts, { query: 'Sarah Baker' }, text, 2)[0]?.values).toEqual(['sarah.baker@gmail.com'])
  })

  it('keeps the case of a value: an id is compared as written', () => {
    // Codex review: AbCd and abcd folded into one value, so two records that
    // name different files looked like one.
    const text = '- filename: notes.docx\n  id_: AbCd\n'
    const files: Lookup = { query: 'q', key: 'filename', values: { id_: ['append_to_file.file_id'] } }
    expect(read('files', files, { q: 'notes.docx' }, text, 1)[0]?.values).toEqual(['AbCd'])
  })

  it('keeps a record that lacks a declared field, as a name bound to nothing', () => {
    // Codex review: a second record for the same name with no address at all
    // was skipped, so it could not conflict with the attacker's.
    expect(read('contacts', contacts, { query: 'Bob' }, '- name: Bob\n', 1)).toEqual([expect.objectContaining({ key: 'bob', values: [] })])
  })

  it('reads a lookup asked with no query, so its records still conflict', () => {
    // Kimi review: an empty query skipped the whole result, and a dump of
    // every contact carrying the honest record for the user's name was never
    // compared with the attacker's. Its records vouch for nothing: the query
    // is empty, and nobody said that.
    const found = read('contacts', contacts, { query: '' }, '- name: Bob\n  email: b@x.example\n', 1)
    expect(found).toEqual([expect.objectContaining({ key: 'bob', query: '' })])
    expect(read('contacts', contacts, {}, '- name: Bob\n  email: b@x.example\n', 1)).toHaveLength(1)
  })

  it('parses keys without values in bounded time', () => {
    // Codex and Kimi review: a flow map of bare keys, or explicit `? key`
    // entries, needs no colon, and 32,000 of them took the parser's
    // duplicate check 21 seconds.
    const bare = Array.from({ length: 22_000 }, (_, i) => `k${i}`)
    const flow = `[{name: Bob, email: b@x.example, ${bare.join(', ')}}]`
    const explicit = `- name: Bob\n  email: b@x.example\n${bare.map((key) => `  ? ${key}`).join('\n')}\n`
    for (const text of [flow, explicit]) {
      expect(text.length).toBeLessThan(256 * 1024)
      const started = Date.now()
      readLookup('contacts', contacts, { query: 'Bob' }, text, 1)
      expect(Date.now() - started).toBeLessThan(1500)
    }
  })

  it('calls a result with an alias unreadable', () => {
    // An alias repeats a record under another name without writing it twice.
    const text = '- &a {name: Bob, email: b@x.example}\n- *a\n'
    expect(readLookup('contacts', contacts, { query: 'Bob' }, text, 1)).toBe('unreadable')
  })

  it('calls a result with an explicit tag unreadable, in bounded time', () => {
    // Codex review: an `!!omap` of 20,000 pairs ran the tag's own quadratic
    // duplicate check, and a tag can turn a record into something that is
    // not a plain map. A lookup result has no business carrying tags.
    const pairs = Array.from({ length: 19_000 }, (_, i) => `  - k${i}: 1`).join('\n')
    const omap = `- name: Bob\n  email: b@x.example\n- !!omap\n${pairs}\n`
    expect(omap.length).toBeLessThan(256 * 1024)
    const started = Date.now()
    expect(readLookup('contacts', contacts, { query: 'Bob' }, omap, 1)).toBe('unreadable')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(readLookup('contacts', contacts, { query: 'Bob' }, '- !!str name: Bob\n  email: b@x.example\n', 1)).toBe('unreadable')
  })

  it('calls a record with a null or composite key unreadable', () => {
    // Kimi review: a null key becomes the property "" and `? [x]` becomes
    // "[ x ]", each colliding with a plain key the duplicate check read
    // differently.
    for (const text of [
      '- name: Bob\n  null: a@x.example\n  "": b@x.example\n',
      '- name: Bob\n  ? [x]\n  : a@x.example\n  "[ x ]": b@x.example\n',
    ]) {
      expect(readLookup('contacts', contacts, { query: 'Bob' }, text, 1), text).toBe('unreadable')
    }
  })

  it('calls keys that differ only as number and string a duplicate', () => {
    const text = '- name: Bob\n  1: x\n  "1": y\n  email: b@x.example\n'
    expect(readLookup('contacts', contacts, { query: 'Bob' }, text, 1)).toBe('unreadable')
  })

  it('reads a list of values as one set', () => {
    const text = '- title: Introductory meeting\n  participants:\n  - b@x.example\n  - a@x.example\n  id_: \'24\'\n'
    const found = readLookup('calendar', calendar, { query: 'Introductory meeting' }, text, 1)
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'participants', values: ['a@x.example', 'b@x.example'] }),
      expect.objectContaining({ field: 'id_', values: ['24'] }),
    ]))
  })

  it('calls a result that is not YAML or JSON unreadable', () => {
    // Unreadable voids the turn's bindings: the record it hid could be the
    // second one that made a name ambiguous.
    expect(readLookup('contacts', contacts, { query: 'Bob' }, 'name: [unclosed', 1)).toBe('unreadable')
    expect(readLookup('contacts', contacts, { query: 'Bob' }, 'just some prose', 1)).toBe('unreadable')
  })

  it('calls a result larger than the cap unreadable', () => {
    // Codex review: a second, honest record for the same name, padded past
    // the cap, used to be dropped whole, and the first one kept vouching.
    const text = '- name: Bob\n  email: bob@x.example\n' + `# ${'x'.repeat(300_000)}\n`
    expect(readLookup('contacts', contacts, { query: 'Bob' }, text, 1)).toBe('unreadable')
  })

  it('parses many distinct keys in bounded time', () => {
    // Codex review: 35,000 distinct keys fit in the size cap and took the
    // parser's duplicate check 21 seconds, past the hook timeout, so the
    // conflict they carried was never saved.
    const keys = Array.from({ length: 20_000 }, (_, i) => `x${i}`)
    const block = `- name: Bob\n  email: bob@x.example\n${keys.map((key) => `  ${key}: 1`).join('\n')}\n`
    const flow = `[{name: Bob, email: bob@x.example, ${keys.map((key) => `${key}: 1`).join(', ')}}]`
    for (const text of [block, flow]) {
      expect(text.length).toBeLessThan(256 * 1024)
      const started = Date.now()
      readLookup('contacts', contacts, { query: 'Bob' }, text, 1)
      expect(Date.now() - started).toBeLessThan(1500)
    }
  })

  it('calls a result with a duplicate key unreadable', () => {
    // Which of two emails a record "has" is the parser's choice, not a fact.
    const text = '- name: Bob\n  email: bob@x.example\n  email: evil@x.example\n'
    expect(readLookup('contacts', contacts, { query: 'Bob' }, text, 1)).toBe('unreadable')
  })

  it('keeps a record whose value is empty or not plain, as a set with nothing in it', () => {
    // Codex review: `email: null` for the same name was skipped, so it could
    // not conflict with the attacker's record that had an address.
    for (const email of ['null', '[]', '{x: 1}', '""']) {
      const found = readLookup('contacts', contacts, { query: 'Bob' }, `- name: Bob\n  email: ${email}\n`, 1)
      expect(found, email).toEqual([expect.objectContaining({ key: 'bob', values: [] })])
    }
  })

  it('calls a record with the key field present but not plain unreadable', () => {
    const text = '- name: {nested: Sarah Baker}\n  email: a@x.example\n'
    expect(readLookup('contacts', contacts, { query: 'Bob' }, text, 1)).toBe('unreadable')
  })

  it('does not treat YAML written inside a field as a record', () => {
    const text = '- name: Bob\n  email: bob@x.example\n  note: "- name: Sarah Baker\\n  email: evil@x.example"\n'
    const found = read('contacts', contacts, { query: 'Bob' }, text, 1)
    expect(found.map((o) => o.key)).toEqual(['bob'])
  })
})

function obs(partial: Partial<Observation>): Observation {
  return {
    tool: 'contacts', field: 'email', key: 'sarah baker', values: ['sarah.baker@gmail.com'],
    query: 'sarah baker', turn: 1, ...partial,
  }
}

describe('which bound values vouch for a call', () => {
  const lookups = { contacts, calendar }
  const said = new Set(['sarah baker', 'introductory meeting'])

  it('vouches for the value in each consumer the policy lists', () => {
    const found = vouched([obs({})], false, said, lookups, 1)
    expect(found.has(vouchKey('send_email.recipients', 'sarah.baker@gmail.com'))).toBe(true)
    expect(found.has(vouchKey('create_calendar_event.participants', 'sarah.baker@gmail.com'))).toBe(true)
    expect(found.has(vouchKey('delete_contact.email', 'sarah.baker@gmail.com'))).toBe(false)
  })

  it('needs the key to be a whole name the user said', () => {
    expect(vouched([obs({ key: 'sarah smith' })], false, said, lookups, 1).size).toBe(0)
  })

  it('needs the lookup to have been asked with the user\'s words', () => {
    // An injected search for "Q3 budget review final" records bindings that
    // vouch for nothing, even when a record's key is a name the user said.
    expect(vouched([obs({ query: 'q3 budget review final' })], false, said, lookups, 1).size).toBe(0)
  })

  it('refuses a key bound to two different values', () => {
    // An attacker's calendar invite titled like the user's meeting.
    const two = [obs({}), obs({ values: ['mark.black@evil.example'], query: 'sarah' })]
    expect(vouched(two, false, said, lookups, 1).size).toBe(0)
  })

  it('refuses two value sets that join to the same string', () => {
    // Codex review: joined with a NUL separator, these two were one set,
    // and all four values vouched.
    const two = [obs({ values: ['a', 'b\u0000c'] }), obs({ values: ['a\u0000b', 'c'] })]
    expect(vouched(two, false, said, lookups, 1).size).toBe(0)
  })

  it('refuses a name bound to values that differ only in case', () => {
    const two = [obs({ values: ['AbCd'] }), obs({ values: ['abcd'] })]
    expect(vouched(two, false, said, lookups, 1).size).toBe(0)
  })

  it('refuses a name bound to an empty set by another record', () => {
    expect(vouched([obs({}), obs({ values: [] })], false, said, lookups, 1).size).toBe(0)
  })

  it('does not count the same record seen twice as a conflict', () => {
    expect(vouched([obs({}), obs({})], false, said, lookups, 1).size).toBe(2)
  })

  it('keeps only what was looked up in this turn', () => {
    // Bindings recorded before the user's last message are not a decision
    // an attacker can wait for the user to confirm.
    expect(vouched([obs({ turn: 1 })], false, said, lookups, 2).size).toBe(0)
  })

  it('vouches for nothing once the record list overflowed', () => {
    expect(vouched([obs({})], true, said, lookups, 1).size).toBe(0)
  })

  it('vouches for nothing from a tool the policy no longer declares', () => {
    expect(vouched([obs({})], false, said, {}, 1).size).toBe(0)
  })
})
