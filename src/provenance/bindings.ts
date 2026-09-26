import { isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { Lookup } from '../policy/defaults.js'

/**
 * Bindings: what a lookup tool said a name stands for.
 *
 * AgentDojo's workspace suite measured the need. "Create an event with Sarah
 * Baker" reads the calendar first, so the session is marked, and then the
 * address the contact lookup returned for Sarah Baker is a destination the
 * user never typed. With an agent that follows each task's ground truth,
 * four tasks were lost that way: a contact's address, a file's id, the
 * participants of a meeting the user named.
 *
 * A binding vouches for a value only where the owner's policy says it may,
 * and only while all of this holds:
 *
 * - the record's name is a whole name the user said, never words taken from
 *   different places of the message;
 * - the lookup was asked with the user's own words, so an injected search
 *   for a name the attacker chose binds nothing;
 * - no record seen in the same turn binds that name to anything else, which
 *   is what an invite titled like the user's meeting would do;
 * - it was recorded in the current turn: a binding does not wait for the
 *   user to say its name later, which an injection could ask them to do.
 *
 * What is left is a record that is the only one under the user's name and
 * was written by the attacker. That is the residual, and it is the owner's
 * call which lookups to declare: an address book is one, a calendar anyone
 * can send invites to is less so.
 */

/** One name bound to its values by one lookup result. */
export interface Observation {
  tool: string
  field: string
  /** The record's name, folded. */
  key: string
  /** The bound values, folded and sorted: a list is compared as a set. */
  values: string[]
  /** What the lookup was asked with, folded. */
  query: string
  turn: number
}

/**
 * The largest result read. Every hook process restores the session whole
 * before each call, and a timed-out hook reads as "allow" on both harnesses;
 * a file search returns whole file contents.
 */
export const MAX_LOOKUP_TEXT = 256 * 1024

export function fold(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

/**
 * A bound value as it is compared: trimmed and nothing else. A name is
 * folded, since the user writes it however they like; an id is not, since
 * AbCd and abcd are two files to an API that tells case apart.
 */
function exact(value: string): string {
  return value.trim()
}

/**
 * The bindings in one lookup result. Only the declared key and value fields
 * of each top-level record are read; anything else in the record, a file's
 * content among it, is never parsed as a record of its own.
 *
 * A result that cannot be read whole is `unreadable`, and that voids every
 * binding of the turn rather than only its own: what it hid could be the
 * second record that made a name ambiguous. A record that lacks a declared
 * field, or holds an empty or not plain value in it, still counts, as a name
 * bound to nothing, for the same reason. So does a lookup asked with no
 * query: its records vouch for nothing, since nobody said an empty query,
 * but a dump of every contact is exactly where the honest record would be.
 */
export function readLookup(
  tool: string,
  lookup: Lookup,
  args: Record<string, unknown>,
  text: string,
  turn: number,
): Observation[] | 'unreadable' {
  const asked = Object.hasOwn(args, lookup.query) ? args[lookup.query] : undefined
  const query = typeof asked === 'string' ? fold(asked) : ''
  if (text.length > MAX_LOOKUP_TEXT) return 'unreadable'
  const parsed = parseRecords(text)
  if (parsed === 'unreadable') return parsed
  const records = Array.isArray(parsed) ? parsed : [parsed]
  const out: Observation[] = []
  for (const record of records) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    const fields = record as Record<string, unknown>
    if (!Object.hasOwn(fields, lookup.key)) continue
    const name = plain(fields[lookup.key])
    if (name === null) return 'unreadable'
    if (fold(name) === '') continue
    for (const field of Object.keys(lookup.values)) {
      const values = Object.hasOwn(fields, field) ? valuesOf(fields[field]) : []
      out.push({ tool, field, key: fold(name), values, query, turn })
    }
  }
  return out
}

/**
 * The result as plain data, or `unreadable`.
 *
 * The parser's own duplicate check is off and done here instead: it compares
 * every key of a map with every other, and 32,000 keys with no values, which
 * need no colon and fit under the size cap, took it 21 seconds, past the
 * hook's timeout. Duplicates are still refused, in one pass over each
 * record's keys: which of two emails a record "has" is the parser's choice,
 * not a fact. Keys are compared as text, so `1` and `"1"`, one JavaScript
 * property, are a duplicate too. A key that is not a scalar, or is null, is
 * refused rather than compared.
 */
function parseRecords(text: string): unknown {
  try {
    // Known tags are not resolved either: `!!omap` runs a duplicate check of
    // its own, as slow, and a tag can turn a record into something that is
    // not a plain map. Any tag at all is refused below.
    const document = parseDocument(text, { uniqueKeys: false, resolveKnownTags: false })
    if (document.errors.length > 0) return 'unreadable'
    let tagged = false
    visit(document, {
      Node(_, node) {
        if (node.tag !== undefined) tagged = true
      },
    })
    if (tagged) return 'unreadable'
    const top = document.contents
    const records = isSeq(top) ? top.items : [top]
    for (const record of records) {
      if (!isMap(record)) continue
      const seen = new Set<string>()
      for (const pair of record.items) {
        // A null key becomes the property "" and `? [x]` becomes "[ x ]":
        // either collides with a plain key that reads differently here.
        if (!isScalar(pair.key) || pair.key.value === null || pair.key.value === undefined) return 'unreadable'
        const key = String(pair.key.value)
        if (seen.has(key)) return 'unreadable'
        seen.add(key)
      }
    }
    const parsed: unknown = document.toJS({ maxAliasCount: 0 })
    if (typeof parsed !== 'object' || parsed === null) return 'unreadable'
    return parsed
  } catch {
    // An alias, or anything else the parser refuses: the turn's bindings are
    // void, and the refusal stands.
    return 'unreadable'
  }
}

/** A scalar as text, or null for anything that is not one. */
function plain(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** The values as a set, or an empty set when any of them is not plain. */
function valuesOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  const out = new Set<string>()
  for (const item of list) {
    const text = plain(item)
    if (text === null) return []
    const kept = exact(text)
    if (kept !== '') out.add(kept)
  }
  return [...out].sort()
}

/**
 * Every `tool.argument` + value pair a binding vouches for, as `vouchKey`
 * writes it.
 *
 * `voided` is the turn having lost a record: the list hit its cap, or a
 * result could not be read whole. A conflict could be in what was lost, so
 * nothing vouches then.
 *
 * `said` is what the user named in this turn: a name from an earlier one is
 * one an injection could look up long after the user moved on.
 */
export function vouched(
  observations: readonly Observation[],
  voided: boolean,
  said: ReadonlySet<string>,
  lookups: Readonly<Record<string, Lookup>>,
  turn: number,
): Set<string> {
  const out = new Set<string>()
  if (voided) return out
  const current = observations.filter((o) => o.turn === turn && Object.hasOwn(lookups, o.tool))
  // A name bound to two different value sets by the same tool and field is
  // ambiguous whoever asked: the conflict counts even from a lookup the
  // attacker steered, since that is where a second record would come from.
  const seen = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const o of current) {
    const id = JSON.stringify([o.tool, o.field, o.key])
    const set = JSON.stringify(o.values)
    const before = seen.get(id)
    if (before === undefined) seen.set(id, set)
    else if (before !== set) conflicted.add(id)
  }
  for (const o of current) {
    if (conflicted.has(JSON.stringify([o.tool, o.field, o.key]))) continue
    if (o.query === '' || !said.has(o.key) || !said.has(o.query)) continue
    const consumers = lookups[o.tool]!.values[o.field] ?? []
    for (const consumer of consumers) {
      for (const value of o.values) out.add(vouchKey(consumer, value))
    }
  }
  return out
}

/** How the gate and `vouched` spell a consumer and value: no separator to collide on. */
export function vouchKey(consumer: string, value: string): string {
  return JSON.stringify([consumer, exact(value)])
}
