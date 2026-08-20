import type { Marks } from './attribute.js'

/** The label length beyond which it is truncated. */
const MAX_LABEL = 120

/**
 * The length of a shared fragment's excerpt in the footer. Longer than a
 * label's: an excerpt is a coherent phrase, and cut off mid-word it does not
 * answer the question it is shown for.
 */
const MAX_EXCERPT = 140

/**
 * How many sources are named one by one.
 *
 * Forty pages read would give forty lines under every answer, and a footer
 * that long is one the human stops reading — that is, the axis falls silent
 * exactly when it has something to say. The rest do not vanish silently:
 * their count is reported.
 */
const MAX_INFLUENCES = 10

/**
 * Characters that reshape what has already been written: newlines, paragraph
 * separators, invisible writing-direction marks.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/**
 * The characters our own markup is counterfeited with.
 *
 * Box drawing and list bullets draw a counterfeit footer structure. Quotation
 * marks separate our voice from a string taken off a page: a label containing
 * one itself would close its own quote and open a counterfeit entry right
 * inside its own line, without any newline at all. Square brackets are
 * removed because the footer is shown in an interface that renders markdown:
 * they turn into a link whose visible text the attacker chooses while the
 * real address is not visible at all. Round brackets stay — without square
 * ones no link comes out of them, and they are common in legitimate
 * addresses.
 */
const FAKE_STRUCTURE = /[\u2500-\u257F\u2022\u00B7\u00AB\u00BB\u0022\u005B\u005D]/gu

/**
 * Defangs a source label before display.
 *
 * The label comes from the untrusted world: it is a link off a page, a path
 * or an MCP tool's name. A newline in it will draw a counterfeit footer line,
 * box drawing will counterfeit its markup, and a bidi override will rearrange
 * what we already wrote.
 *
 * The label is cut at the first control character rather than joined with a
 * space. Joining would keep the text appended to the link, and it would read
 * as Cordon speaking inside a genuine footer: `https://evil.example/` plus a
 * newline plus "source verified" would turn into one line in our voice. A
 * control character in a label is not content but an attempt to reshape our
 * interface, and everything after it does not belong to the label.
 *
 * An ordinary space is preserved: a path with a space and a command with
 * arguments are legitimate labels, and cutting them would mean lying to the
 * human about what exactly influenced the answer.
 */
function safeLabel(label: string): string {
  return flatten(label, MAX_LABEL) || 'a source without a label'
}

/**
 * Defangs a shared fragment's excerpt.
 *
 * The same way and for the same reason as a label. An excerpt is a piece of
 * the answer that matched an untrusted source, that is, literally the
 * attacker's text: a newline in it would draw a counterfeit footer line in
 * our voice. An empty excerpt is the absence of an excerpt, not a
 * placeholder — there is nothing to lie about in what we did not show.
 */
function safeExcerpt(excerpt: string): string {
  return flatten(excerpt, MAX_EXCERPT)
}

function flatten(raw: string, max: number): string {
  const attack = raw.search(CONTROL)
  const head = attack < 0 ? raw : raw.slice(0, attack)
  const flat = head.replace(FAKE_STRUCTURE, ' ').replace(/\s+/gu, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '...' : flat
}

/**
 * The text of the footer appended to the displayed answer.
 *
 * The footer is one-sided. It lists what it saw and passes no judgement about
 * corroboration: the dominant attack on output looks like several formally
 * independent domains, and the word "confirmed" on it would produce exactly
 * the confidence the attacker is after.
 */
export function renderFooter(marks: Marks): string {
  const lines: string[] = []

  // The sources with the most matches are named first: if the list had to be
  // trimmed, its tail should be trimmed, not its head.
  const ranked = [...marks.influences].sort((a, b) => b.fragments - a.fragments)

  for (const influence of ranked.slice(0, MAX_INFLUENCES)) {
    const notes: string[] = [`matching spans: ${influence.fragments}`]
    if (influence.selfReported) notes.push('only the source itself testifies about it')
    if (influence.syndicated) notes.push('a syndication platform, the subject wrote the text')
    // The label is quoted: the human must see where our voice ends and a
    // string taken off a page begins.
    lines.push(`  - "${safeLabel(influence.label)}": ${notes.join('; ')}`)
  }

  const hidden = ranked.length - MAX_INFLUENCES
  if (hidden > 0) {
    lines.push(`  - and ${hidden} more sources with verbatim matches, not listed here`)
  }

  for (const group of marks.kinship) {
    const named = group.labels.map((label) => `"${safeLabel(label)}"`).join(', ')
    // The shared fragment is shown to the human verbatim, because there is no
    // mechanical way to tell a quotation of a statute from coordinated
    // praise, while the eye does it in a second.
    //
    // The bounds are called approximate because that is what they are. The
    // provenance index stores window hashes rather than text, so the exact
    // shared piece cannot be reconstructed in principle; a span is mapped
    // back to word precision and deliberately with an outward margin — the
    // same span serves quarantine, which must cut with a margin. The excerpt
    // may therefore pick up a word or two of the answer itself, and the human
    // is told so, lest they take the model's words for copied ones.
    const excerpt = safeExcerpt(group.excerpt)
    const shown = excerpt === '' ? '' : `; shared fragment, bounds approximate: "${excerpt}"`
    lines.push(`  - the sources are not independent, their text matches verbatim: ${named}${shown}`)
  }

  if (marks.truncated) {
    lines.push('  - the answer is long, not all of it was checked')
  }

  if (lines.length === 0) return ''

  return [
    '',
    'Cordon, the influence of sources on this answer:',
    ...lines,
    'The absence of a mark confirms nothing: a retelling in other words is invisible here.',
  ].join('\n')
}
