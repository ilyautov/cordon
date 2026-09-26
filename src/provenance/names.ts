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
 * - A quoted phrase with a space in it is not a name. Users quote commands,
 *   and a quoted `rm -rf build` as a name would exempt an injected exec of
 *   exactly that command, which carries no atom for anything else to catch.
 * - A lowercase word is not a name, so "don't make this public" does not name
 *   a destination called public.
 * - The first word of a sentence is not a name. Every sentence opens with a
 *   capital, and "Send", "Delete", "Thanks" would all become names within a
 *   few turns.
 * - A capitalized word shorter than three letters is not a name.
 *
 * What remains: a capitalized word inside a sentence, and a single quoted
 * token. Both are stored in lower case; the gate compares a whole argument
 * value, case-folded, and never a part of one.
 */

/** Quote pairs a single quoted token may sit between. */
const QUOTED = /(?:'([^'\s]{1,64})'|"([^"\s]{1,64})"|`([^`\s]{1,64})`|\u2018([^\u2019\s]{1,64})\u2019|\u201C([^\u201D\s]{1,64})\u201D)/gu

/** The characters a quoted token may consist of: no shell syntax, no paths. */
const TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}_.#@-]*$/u

/** A word that starts with a capital letter, at least three letters long. */
const CAPITALIZED = /\p{Lu}[\p{L}\p{N}_-]{2,}/gu

/** What ends a sentence, so that the word after it is sentence-initial. */
const SENTENCE_END = /[.!?:;\n]\s*$/u

export function names(text: string): string[] {
  const found = new Set<string>()
  const source = text.normalize('NFKC')

  for (const match of source.matchAll(QUOTED)) {
    const token = match.slice(1).find((group) => group !== undefined)
    if (token !== undefined && TOKEN.test(token)) found.add(token.toLowerCase())
  }

  for (const match of source.matchAll(CAPITALIZED)) {
    const at = match.index
    // Inside a word ("McDonald" is found at "Donald"): not a word start.
    if (at > 0 && /[\p{L}\p{N}_-]/u.test(source[at - 1]!)) continue
    const before = source.slice(0, at).replace(/["'`\u2018\u201C(]+$/u, '')
    if (before.trim() === '' || SENTENCE_END.test(before)) continue
    found.add(match[0].toLowerCase())
  }

  return [...found]
}
