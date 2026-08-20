import type { Source, SourceView, TrustLabel } from '../core/types.js'
import {
  SHINGLE_STEP,
  SHINGLE_WINDOW,
  atoms,
  formatHash,
  hashCodes,
  mapWords,
  normalize,
  originalSpan,
  parseHash,
} from './normalize.js'

export interface TaintMatch {
  tainted: boolean
  sources: Source[]
  /** The spans of the original value covered by the match. */
  spans: Array<[number, number]>
  /**
   * The same spans, broken down by source.
   *
   * It exists because the combined list is not enough for the third axis: the
   * "testifies about itself" mark must look at that source's own spans rather
   * than at the shared ones. Otherwise a quotation of somebody else's name in
   * one source's text would mark the other one.
   */
  bySource: Array<{ id: string; spans: Array<[number, number]> }>
  /** The atomic tokens found in the value. */
  atoms: string[]
}

/** More than four sources per window add nothing to the conclusion. */
const MAX_SOURCES_PER_SHINGLE = 4

/**
 * How many shared windows count as a sign of common origin.
 *
 * One window is 32 consecutive characters, and two honest texts may well
 * share it: a legal boilerplate, a cookie notice, a quotation of a statute.
 * Three windows can no longer be explained by coincidence.
 */
const SHARED_WINDOWS_FOR_KINSHIP = 3

export interface StoreJSON {
  sources: Source[]
  shingles: Array<[string, string]>
  atoms: Array<[string, string]>
}

/**
 * Remembers exactly what the agent read from untrusted sources, so as to
 * recognize those fragments later in call arguments.
 *
 * A trusted source is not recorded at all: marking the user's own text means
 * getting in the way of the work with no benefit to the defence.
 */
export class TaintStore {
  private readonly sources = new Map<string, Source>()
  /**
   * The sources of each window. A list rather than a single source: a window
   * shared by two different sources is precisely the mechanical sign that
   * they are not independent, and first-one-wins erased that sign.
   *
   * The list is bounded from above: after a window's fourth source the
   * question "are they independent" is already settled, and there is no
   * reason for the index to keep growing.
   */
  private readonly byShingle = new Map<string, string[]>()
  private readonly byAtom = new Map<string, string>()
  /**
   * The first halves of the index's hashes. A numeric prefilter ahead of the
   * lookup in byShingle: the overwhelming majority of a query's windows have
   * no match, and building a string key for them is not worth it. It can only
   * reject what is certainly not in the index, so it does not affect the
   * result.
   */
  private readonly prefilter = new Set<number>()

  record(text: string, source: Source): void {
    // Exactly the label "trusted" is skipped and nothing else. A label of an
    // unknown kind means a broken adapter, and recording too much here is
    // cheaper than not recording: what is not recorded is never found.
    if (source.trust === 'trusted') return
    this.sources.set(source.id, source)

    const normalized = normalize(text)
    for (let at = 0; at + SHINGLE_WINDOW <= normalized.length; at += SHINGLE_STEP) {
      const codes = hashCodes(normalized, at, at + SHINGLE_WINDOW)
      this.prefilter.add(codes[0])
      const key = formatHash(codes)
      const known = this.byShingle.get(key)
      if (!known) this.byShingle.set(key, [source.id])
      else if (!known.includes(source.id) && known.length < MAX_SOURCES_PER_SHINGLE) {
        known.push(source.id)
      }
    }
    for (const atom of atoms(text)) {
      if (!this.byAtom.has(atom)) this.byAtom.set(atom, source.id)
    }
  }

  check(value: string): TaintMatch {
    const hits = new Set<string>()
    const spans: Array<[number, number]> = []
    const perSource = new Map<string, Array<[number, number]>>()
    const found: string[] = []

    const map = mapWords(value)
    const normalized = map.exact ? map.text : normalize(value)

    // Step 1 on lookup: the index is thinned out, the query is not.
    // Otherwise a match that did not land on a step boundary would slip by.
    for (let at = 0; at + SHINGLE_WINDOW <= normalized.length; at++) {
      const codes = hashCodes(normalized, at, at + SHINGLE_WINDOW)
      if (!this.prefilter.has(codes[0])) continue
      const owners = this.byShingle.get(formatHash(codes))
      if (owners === undefined) continue
      for (const id of owners) hits.add(id)
      // Mapping the offset back does not always succeed. When it does not,
      // the whole value is declared tainted: quarantine must cut with a
      // margin rather than guess.
      const span: [number, number] = originalSpan(map, at, at + SHINGLE_WINDOW) ?? [0, value.length]
      spans.push(span)
      for (const id of owners) {
        const own = perSource.get(id) ?? []
        own.push(span)
        perSource.set(id, own)
      }
    }

    const lowered = value.toLowerCase()
    for (const atom of atoms(value)) {
      const sourceId = this.byAtom.get(atom)
      if (sourceId === undefined) continue
      hits.add(sourceId)
      found.push(atom)
      let at = lowered.indexOf(atom)
      while (at >= 0) {
        const span: [number, number] = [at, at + atom.length]
        spans.push(span)
        const own = perSource.get(sourceId) ?? []
        own.push(span)
        perSource.set(sourceId, own)
        at = lowered.indexOf(atom, at + atom.length)
      }
    }

    return {
      tainted: hits.size > 0,
      sources: [...hits].map((id) => this.sources.get(id)).filter((s): s is Source => Boolean(s)),
      spans: merge(spans),
      bySource: [...perSource].map(([id, own]) => ({ id, spans: merge(own) })),
      atoms: found,
    }
  }

  /**
   * Groups of sources whose text matches verbatim.
   *
   * A one-sided sign, like the whole third axis: a match means common origin,
   * that is, syndication, a reprint or a coordinated campaign, while its
   * absence does not mean independence. A retelling in one's own words
   * produces no shared windows and is invisible here.
   */
  notIndependent(): Array<Set<string>> {
    // A pair is counted in a nested map rather than under a glued key. A
    // source identifier also arrives from disk, that is, from outside: a
    // separator inside the identifier itself would glue two different pairs
    // into one.
    const together = new Map<string, Map<string, number>>()
    for (const owners of this.byShingle.values()) {
      if (owners.length < 2) continue
      const sorted = [...owners].sort()
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const left = sorted[i] ?? ''
          const right = sorted[j] ?? ''
          const row = together.get(left) ?? new Map<string, number>()
          row.set(right, (row.get(right) ?? 0) + 1)
          together.set(left, row)
        }
      }
    }

    const groups: Array<Set<string>> = []
    for (const [left, row] of together) {
      for (const [right, count] of row) {
        if (count < SHARED_WINDOWS_FOR_KINSHIP) continue
        // Every group the pair touches is merged, not just the first one
        // encountered: otherwise a single source would end up in two footer
        // lines, and the human would read about two kinships instead of one.
        const touching = groups.filter((group) => group.has(left) || group.has(right))
        const first = touching[0]
        if (!first) {
          groups.push(new Set([left, right]))
          continue
        }
        first.add(left)
        first.add(right)
        for (const other of touching.slice(1)) {
          for (const id of other) first.add(id)
          groups.splice(groups.indexOf(other), 1)
        }
      }
    }
    return groups
  }

  toJSON(): StoreJSON {
    // A window's source list is unrolled into repeated pairs: the file's
    // shape does not change, and what a previous version wrote still reads as
    // before.
    const shingles: Array<[string, string]> = []
    for (const [key, owners] of this.byShingle) {
      for (const id of owners) shingles.push([key, id])
    }
    return {
      sources: [...this.sources.values()],
      shingles,
      atoms: [...this.byAtom],
    }
  }

  /**
   * Restores the store from disk.
   *
   * Malformed data is an exception, not an empty store. An empty store means
   * "nothing is tainted", that is, a silent removal of the second axis of
   * defence exactly where the file was corrupted or substituted. A refusal to
   * read is noticeable, a quiet loss of memory is not.
   */
  static fromJSON(data: unknown): TaintStore {
    const input = asObject(data, 'store')
    const store = new TaintStore()

    for (const raw of asArray(input, 'sources', 'store.sources')) {
      const source = asSource(raw)
      store.sources.set(source.id, source)
    }
    for (const [key, id] of asPairs(input, 'shingles', 'store.shingles')) {
      const codes = parseHash(key)
      // A key we cannot parse will never pass the prefilter again: the taint
      // record would stay dead in the index and the tainted fragment would
      // pass as clean. A refusal is louder than a loss.
      if (!codes) throw new Error(`store.shingles: the key ${key} was not built by us`)
      store.prefilter.add(codes[0])
      const known = store.byShingle.get(key)
      if (!known) store.byShingle.set(key, [id])
      else if (!known.includes(id) && known.length < MAX_SOURCES_PER_SHINGLE) known.push(id)
    }
    for (const [atom, id] of asPairs(input, 'atoms', 'store.atoms')) {
      store.byAtom.set(atom, id)
    }
    return store
  }
}

const KINDS: ReadonlySet<string> = new Set<Source['kind']>([
  'user', 'system', 'web', 'tool', 'mcp-description', 'file', 'bash',
])

const TRUST: ReadonlySet<string> = new Set<TrustLabel>(['trusted', 'untrusted'])

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`)
  }
  return value as Record<string, unknown>
}

/**
 * A field is read only as an own property. The data comes from a file, that
 * is, from outside: a lookup by name through the prototype would return a
 * member of Object.prototype, and a store without a single field would pass
 * as intact.
 */
function own(input: Record<string, unknown>, field: string, where: string): unknown {
  if (!Object.hasOwn(input, field)) throw new Error(`${where}: the field is absent`)
  return input[field]
}

function asArray(input: Record<string, unknown>, field: string, where: string): unknown[] {
  const value = own(input, field, where)
  if (!Array.isArray(value)) throw new Error(`${where}: expected a list`)
  return value
}

function asPairs(
  input: Record<string, unknown>,
  field: string,
  where: string,
): Array<[string, string]> {
  return asArray(input, field, where).map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`${where}: expected a pair`)
    const [key, id] = pair
    if (typeof key !== 'string' || typeof id !== 'string') {
      throw new Error(`${where}: expected strings`)
    }
    return [key, id]
  })
}

/**
 * The source view declared by the policy, taken from the record on disk.
 *
 * The field may be absent entirely, and that is not an error: there was no
 * declaration, or the file was written by a version of Cordon that did not
 * know about declarations yet. A field with a foreign value, on the other
 * hand, is a corrupted file, and staying silent about it is not allowed for
 * exactly the same reason as for the store's other fields.
 *
 * A fragment of an object is returned so that the absence of a declaration
 * does not turn into a field whose value is undefined: sources are compared
 * whole in tests.
 */
function asDeclaredView(source: Record<string, unknown>): { declaredView?: SourceView } {
  if (!Object.hasOwn(source, 'declaredView')) return {}
  const declared = source['declaredView']
  if (declared === undefined) return {}
  if (declared !== 'rendered' && declared !== 'source') {
    throw new Error(`store.sources[].declaredView: unknown view ${String(declared)}`)
  }
  return { declaredView: declared }
}

function asSource(value: unknown): Source {
  const source = asObject(value, 'store.sources[]')
  const id = own(source, 'id', 'store.sources[].id')
  const kind = own(source, 'kind', 'store.sources[].kind')
  const label = own(source, 'label', 'store.sources[].label')
  const trust = own(source, 'trust', 'store.sources[].trust')

  if (typeof id !== 'string' || id === '') throw new Error('store.sources[].id: expected a string')
  if (typeof label !== 'string') throw new Error('store.sources[].label: expected a string')
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new Error(`store.sources[].kind: unknown kind ${String(kind)}`)
  }
  if (typeof trust !== 'string' || !TRUST.has(trust)) {
    throw new Error(`store.sources[].trust: unknown label ${String(trust)}`)
  }
  return {
    id,
    kind: kind as Source['kind'],
    label,
    trust: trust as TrustLabel,
    ...asDeclaredView(source),
  }
}

function merge(spans: Array<[number, number]>): Array<[number, number]> {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const first = sorted[0]
  if (!first) return []
  const result: Array<[number, number]> = [[first[0], first[1]]]
  for (const [start, end] of sorted.slice(1)) {
    const last = result[result.length - 1]
    if (!last) continue
    if (start <= last[1]) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}
