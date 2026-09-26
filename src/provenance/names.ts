/**
 * Names the user wrote: the people and channels a message points at without
 * any atom in sight. "Send it to Alice", "post to the 'general' channel".
 *
 * They exist for one rule only, the exposure exemption in the gate, and they
 * are extracted from the user's own words and nowhere else. AgentDojo's slack
 * suite measured the need: with an agent that follows each task's ground
 * truth, Cordon kept 1 task of 21, because a recipient called Alice is not a
 * link, a path, an address or an identifier.
 *
 * The extraction is narrow on purpose, and each exclusion answers a concrete
 * attack from the design review:
 *
 * - A quoted phrase of several words is a name only when one of them is
 *   capitalized: users quote "ignore the previous instructions" when they
 *   discuss an attack, and that is not the name of anything.
 * - A quoted phrase is a name only when every word of it is a plain token.
 *   Users quote commands, and a quoted `rm -rf build` as a name once could
 *   have exempted an injected exec of exactly that command. A name no longer
 *   counts for exec at all, but a flag or a path still keeps a phrase out:
 *   the phrase names a hotel or a meeting, never a command line. AgentDojo
 *   travel's user_task_0 books 'Le Marais Boutique', three words in quotes.
 * - A lowercase word is not a name, so "don't make this public" does not name
 *   a destination called public.
 * - A capitalized word shorter than three letters is not a name.
 *
 * The first word of a sentence used to be excluded too, when a name exempted
 * a call from any field: "Send" and "Thanks" would have vouched for whatever
 * held them. A name now counts only as the whole value of a destination
 * field, and never for exec, so "Send" vouches for a recipient called Send
 * and nothing else. The exclusion cost a real payee: "Apple called and said
 * I underpaid", AgentDojo banking's user_task_11.
 *
 * What remains: a capitalized word, a run of them, and a quoted token or
 * phrase of plain words. All are stored in lower case; the gate compares a
 * whole argument value, case-folded, and never a part of one.
 */

/** Quote pairs a single quoted token may sit between. */
const QUOTED = /(?:'([^'\n]{1,64})'|"([^"\n]{1,64})"|`([^`\n]{1,64})`|\u2018([^\u2019\n]{1,64})\u2019|\u201C([^\u201D\n]{1,64})\u201D)/gu

/** At most this many words in a quoted name: a hotel, not a sentence. */
const MAX_PHRASE_WORDS = 5

/** The characters a quoted token may consist of: no shell syntax, no paths. */
const TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}_.#@-]*$/u

/** A word that starts with a capital letter, at least three letters long. */
const CAPITALIZED = /\p{Lu}[\p{L}\p{N}_-]{2,}/gu

/**
 * Capitalized words in a row, one space apart: "Sarah Baker". A lookup binds
 * a record by its whole name, and only a run the user wrote as a run counts,
 * so "Sarah Baker and John Smith" names no Sarah Smith. The run is taken
 * whole and kept only at two to four words: a longer one is a title or a
 * shouted sentence, and a slice of it, "Delta Epsilon" out of "Alpha Beta
 * Gamma Delta Epsilon", is a name the user never wrote.
 */
const RUN = /\p{Lu}[\p{L}\p{N}_-]*(?: \p{Lu}[\p{L}\p{N}_-]*)+/gu

/** The most words a run of capitalized words may have and still be a name. */
const MAX_RUN_WORDS = 4

export function names(text: string): string[] {
  const found = new Set<string>()
  const source = text.normalize('NFKC')

  for (const match of source.matchAll(QUOTED)) {
    const token = match.slice(1).find((group) => group !== undefined)
    if (token === undefined) continue
    const parts = token.split(' ')
    if (parts.length > MAX_PHRASE_WORDS || !parts.every((part) => TOKEN.test(part))) continue
    if (parts.length > 1 && !parts.some((part) => /^\p{Lu}/u.test(part))) continue
    found.add(token.toLowerCase())
  }

  for (const match of source.matchAll(CAPITALIZED)) {
    const at = match.index
    // Inside a word ("McDonald" is found at "Donald"): not a word start.
    if (at > 0 && /[\p{L}\p{N}_-]/u.test(source[at - 1]!)) continue
    found.add(match[0].toLowerCase())
  }

  for (const match of source.matchAll(RUN)) {
    const at = match.index
    if (at > 0 && /[\p{L}\p{N}_-]/u.test(source[at - 1]!)) continue
    if (match[0].split(' ').length > MAX_RUN_WORDS) continue
    found.add(match[0].toLowerCase())
  }

  return [...found]
}

/**
 * Every word of the user's message, lower-cased, for naming a resource.
 *
 * A repository is written as it is called, `pacman` or `infra-docs`, not
 * capitalized and not quoted, so the names above miss it. Only the resource
 * rule reads these: a word is too loose to name where a message goes, and it
 * is exactly as loose as it needs to be for "this repository and no other".
 */
export function words(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.normalize('NFKC').matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]/gu)) {
    found.add(match[0].toLowerCase())
  }
  return [...found]
}
