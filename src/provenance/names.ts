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
 * - A capitalized word shorter than three letters is not a name.
 *
 * The first word of a sentence used to be excluded too, when a name exempted
 * a call from any field: "Send" and "Thanks" would have vouched for whatever
 * held them. A name now counts only as the whole value of a destination
 * field, and never for exec, so "Send" vouches for a recipient called Send
 * and nothing else. The exclusion cost a real payee: "Apple called and said
 * I underpaid", AgentDojo banking's user_task_11.
 *
 * What remains: a capitalized word, and a single quoted token. Both are stored in lower case; the gate compares a whole argument
 * value, case-folded, and never a part of one.
 */

/** Quote pairs a single quoted token may sit between. */
const QUOTED = /(?:'([^'\s]{1,64})'|"([^"\s]{1,64})"|`([^`\s]{1,64})`|\u2018([^\u2019\s]{1,64})\u2019|\u201C([^\u201D\s]{1,64})\u201D)/gu

/** The characters a quoted token may consist of: no shell syntax, no paths. */
const TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}_.#@-]*$/u

/** A word that starts with a capital letter, at least three letters long. */
const CAPITALIZED = /\p{Lu}[\p{L}\p{N}_-]{2,}/gu

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
