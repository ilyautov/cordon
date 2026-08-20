import type { TaintStore } from '../provenance/store.js'
import { SHINGLE_STEP, SHINGLE_WINDOW } from '../provenance/normalize.js'
import { isSyndication, subjectOf } from './subject.js'

export interface Influence {
  /** The source label as provenance saw it. It may be hostile. */
  label: string
  /** How many spans of the answer matched this source verbatim. */
  fragments: number
  /** The matched text contains the source's own name. */
  selfReported: boolean
  /** The source is a syndication platform, so the subject wrote the text. */
  syndicated: boolean
}

export interface Kinship {
  /** The labels of sources whose text matches verbatim. */
  labels: string[]
  /**
   * A short excerpt of the shared piece of the answer. Empty when the shared
   * piece is known only from the index and was not found in the answer's
   * spans.
   *
   * It exists because there is no mechanical way to tell a shared quotation
   * of a third party from coordinated praise: two honest articles quoting the
   * same paragraph of a statute produce exactly the sign two astroturfed
   * reviews do. A human can tell them apart — if they see what text turned
   * out to be shared. The excerpt creates no new surface: this text already
   * stands in the displayed answer. But it came from the untrusted world, so
   * it is defanged on a par with the source label.
   */
  excerpt: string
}

export interface Marks {
  influences: Influence[]
  /** Groups of sources whose text matches verbatim. */
  kinship: Kinship[]
  /** The answer is longer than the limit, only part of it was checked. */
  truncated: boolean
}

/**
 * The analysis limit. The display event gives 10 seconds, and checking a text
 * of several megabytes will not fit into them. Silently looking at only a
 * piece is not allowed: the footer would say "no matches" about what it never
 * read. So the limit exists, and it is reported.
 */
const MAX_ANSWER = 200_000

/**
 * The length of the shared fragment's excerpt. A line is enough for the human
 * to recognize a quotation of a statute or spot an advertising turn of
 * phrase, and short enough to keep the footer from becoming a second copy of
 * the answer.
 */
const MAX_EXCERPT = 120

export function attribute(answer: string, taint: TaintStore): Marks {
  const truncated = answer.length > MAX_ANSWER
  const text = truncated ? answer.slice(0, MAX_ANSWER) : answer

  const hit = taint.check(text)
  const byId = new Map(hit.sources.map((source) => [source.id, source]))
  const lowered = text.toLowerCase()

  const influences: Influence[] = hit.bySource.map((entry) => {
    const source = byId.get(entry.id)
    const subject = source ? subjectOf(source) : null
    // The subject's name is looked for in THIS source's spans, not in the
    // shared ones. Otherwise a quotation of somebody else's name in one
    // source's text would mark the other one, and a false mark about trust is
    // worse than a missing one.
    //
    // The span is widened by the index step in both directions. This is not a
    // just-in-case margin: windows go into the index every SHINGLE_STEP
    // characters, so the first and last up to eight characters of the text
    // that actually matched never fall inside the span that was found. The
    // subject's name stands precisely at the start of the phrase about it,
    // that is, exactly in that blind spot.
    const namedInOwnSpans = entry.spans.some(([from, to]) => {
      const piece = lowered.slice(Math.max(0, from - SHINGLE_STEP), to + SHINGLE_STEP)
      return (subject?.names ?? []).some((name) => piece.includes(name))
    })
    return {
      label: source?.label ?? 'a source without a label',
      fragments: entry.spans.length,
      selfReported: subject !== null && namedInOwnSpans,
      syndicated: subject !== null && isSyndication(subject.host),
    }
  })

  // Kinship is named only about sources that actually made it into this
  // answer: an unknown label is discarded, and a group of one source is no
  // longer kinship. Saying "the sources are not independent" about something
  // absent from the answer means lying about it.
  const groups: Group[] = []
  for (const [left, right, from, to] of sharedFragments(hit.bySource)) {
    join(groups, left, right, excerptOf(text, from, to))
  }
  for (const group of taint.notIndependent()) {
    const present = [...group].filter((id) => byId.has(id))
    // The index-based sign yields no excerpt: it knows the window is shared
    // but not which piece of the answer corresponds to it.
    for (const id of present.slice(1)) join(groups, present[0] ?? id, id, '')
  }

  const kinship: Kinship[] = groups
    .map((group) => ({
      labels: [...group.ids].map((id) => byId.get(id)?.label).filter((l): l is string => Boolean(l)),
      excerpt: group.excerpt,
    }))
    .filter((group) => group.labels.length > 1)

  return { influences, kinship, truncated }
}

/**
 * Pairs of sources that own one and the same piece of the answer.
 *
 * Kinship is computed from the answer's spans and not only from the source
 * index, and that is not decoration. The index is thinned by SHINGLE_STEP:
 * two sources with a verbatim shared paragraph land in the index under the
 * same windows only when the paragraph sits at offsets congruent modulo the
 * step. On live pages that is roughly one case in eight, meaning the
 * index-based sign would stay silent on the dominant attack seven times out
 * of eight. A query, on the other hand, runs at every offset, so shared text
 * is always visible in the answer's spans.
 *
 * The overlap must be as long as a window. Neighbouring spans of two honest
 * sources share a word boundary, not text, and are not kinship.
 */
function sharedFragments(
  bySource: ReadonlyArray<{ id: string; spans: Array<[number, number]> }>,
): Array<[string, string, number, number]> {
  const pairs: Array<[string, string, number, number]> = []
  for (let i = 0; i < bySource.length; i++) {
    for (let j = i + 1; j < bySource.length; j++) {
      const left = bySource[i]
      const right = bySource[j]
      if (!left || !right) continue
      const shared = overlap(left.spans, right.spans)
      if (shared) pairs.push([left.id, right.id, shared[0], shared[1]])
    }
  }
  return pairs
}

/** The first MAX_EXCERPT characters of the shared piece, with an ellipsis if it is longer. */
function excerptOf(text: string, from: number, to: number): string {
  const piece = text.slice(from, Math.min(to, from + MAX_EXCERPT)).trim()
  if (piece === '') return ''
  return to - from > MAX_EXCERPT ? `${piece}...` : piece
}

/** The span lists are sorted and do not overlap themselves, hence the two-pointer walk. */
function overlap(
  left: Array<[number, number]>,
  right: Array<[number, number]>,
): [number, number] | null {
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left[i]
    const b = right[j]
    if (!a || !b) break
    const from = Math.max(a[0], b[0])
    const to = Math.min(a[1], b[1])
    if (to - from >= SHINGLE_WINDOW) return [from, to]
    if (a[1] < b[1]) i++
    else j++
  }
  return null
}

interface Group {
  ids: Set<string>
  excerpt: string
}

/**
 * Merges every group the pair touches into one: a source must not end up in
 * two footer lines.
 *
 * A group has one excerpt, the first one found. Showing them all would mean
 * retelling the human the entire shared text, whereas showing "some" of it is
 * the whole point: it answers the question "what exactly do they have in
 * common" rather than standing in for the answer.
 */
function join(groups: Group[], left: string, right: string, excerpt: string): void {
  const touching = groups.filter((group) => group.ids.has(left) || group.ids.has(right))
  const first = touching[0]
  if (!first) {
    groups.push({ ids: new Set([left, right]), excerpt })
    return
  }
  first.ids.add(left)
  first.ids.add(right)
  if (first.excerpt === '') first.excerpt = excerpt
  for (const other of touching.slice(1)) {
    for (const id of other.ids) first.ids.add(id)
    if (first.excerpt === '') first.excerpt = other.excerpt
    groups.splice(groups.indexOf(other), 1)
  }
}
