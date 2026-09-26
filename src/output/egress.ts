/**
 * Links and images in the model's answer that would carry data out when the
 * answer is shown.
 *
 * The call gate never sees these: no tool is called. The answer itself is the
 * channel. A markdown image is fetched by the viewer the moment the answer
 * renders, so its address is a request the attacker receives with no click
 * (EchoLeak, CVE-2025-32711; the Slack AI and ChatGPT image leaks). A link
 * needs a click and carries whatever the model wrote into it.
 *
 * An allowlist of hosts does not answer this. CamoLeak went through GitHub's
 * own image proxy: the page supplied one pre-signed proxy address per
 * character, and the order the model emitted them in was the secret. So an
 * image counts wherever it points, unless the user named it themselves.
 *
 * The functions here are pure. Whether the session read untrusted content,
 * and so whether any of this applies, is the caller's question.
 */

import type { ExposureMark } from '../core/types.js'
import type { Policy } from '../policy/defaults.js'
import type { TaintStore } from '../provenance/store.js'

export interface Outbound {
  kind: 'image' | 'link'
  /** The address as the answer wrote it. */
  url: string
  /** The host, reduced to characters a host can have: it is shown to the human. */
  host: string
  start: number
  end: number
  /** The link's own text, kept when the address is cut. */
  text: string
}

/** Who already said an address, verbatim: the user, a source that was read, or nobody. */
export type Known = (url: string) => 'user' | 'source' | null

interface Candidate {
  kind: 'image' | 'link'
  url: string
  start: number
  end: number
  text: string
}

/**
 * Everything in the answer that would send data out.
 *
 * An image counts unless the user named its address. A link passes when it
 * was copied whole from the user or from what was read, and otherwise only
 * when the user named its host and the address carries nothing beyond a
 * place: no query, no userinfo, no identifier in the path or fragment. A
 * host seen only in what was read vouches for nothing, because the page can
 * name its own collector; and a host the model composed can carry data in
 * itself, `secret123.evil.example`.
 */
export function outbound(answer: string, known: Known, userHost: (host: string) => boolean = () => false): Outbound[] {
  const found: Outbound[] = []
  for (const candidate of candidates(answer)) {
    const who = known(candidate.url)
    if (who === 'user') continue
    const host = hostOf(candidate.url)
    if (candidate.kind === 'link' && (who === 'source' || (userHost(host) && !carriesData(candidate.url)))) continue
    found.push({ ...candidate, host })
  }
  return found
}

export interface AnswerSession {
  taint: TaintStore
  exposure?: ExposureMark | null
  unredacted?: boolean
  userAtoms?: readonly string[]
}

/**
 * The same, answered from the session: nothing unless the session read
 * untrusted content since the user's last message. Without a read there is
 * no one to have planted the address, and an answer's links are the user's
 * business. `exposure: false` switches this off with the rule it belongs to.
 */
export function outboundAfterRead(answer: string, session: AnswerSession, policy: Policy): Outbound[] {
  if (policy.exposure === false) return []
  const exposed = (session.exposure !== undefined && session.exposure !== null) || session.unredacted === true
  if (!exposed) return []
  const named = new Set((session.userAtoms ?? []).map((atom) => atom.toLowerCase()))
  const hosts = new Set([...named].map((atom) => hostOf(/^[a-z][a-z0-9+.-]*:\/\//iu.test(atom) ? atom : `https://${atom}`)))
  return outbound(answer, (url) => {
    // The whole address only, with and without its scheme, lower-cased as
    // atoms are. Every atom of it would let a composed link borrow its
    // standing from one identifier in it that the page happened to say.
    const lowered = url.toLowerCase()
    const forms = [lowered, lowered.replace(/^https?:\/\//u, '')]
    if (forms.some((form) => named.has(form))) return 'user'
    if (forms.some((form) => session.taint.holds(form))) return 'source'
    return null
  }, (host) => hosts.has(host))
}

/** The answer with every found item replaced by a note naming its host. */
export function cutOutbound(answer: string, found: readonly Outbound[]): string {
  let result = answer
  for (const item of [...found].sort((a, b) => b.start - a.start)) {
    const note = item.kind === 'image'
      ? `[image removed by Cordon: ${item.host}]`
      : `${item.text === '' ? '' : `${item.text} `}[link removed by Cordon: ${item.host}]`
    result = result.slice(0, item.start) + note + result.slice(item.end)
  }
  return result
}

const TITLE = String.raw`(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?`
// Link text may hold an escaped bracket: `![a\]b](url)` is one image.
const LABEL = String.raw`((?:\\.|[^\]\\\n])*)`
const INLINE_IMAGE = new RegExp(String.raw`!\[${LABEL}\]\(\s*<?([^\s)>]+)>?${TITLE}\s*\)`, 'gu')
const INLINE_LINK = new RegExp(String.raw`\[${LABEL}\]\(\s*<?([^\s)>]+)>?${TITLE}\s*\)`, 'gu')
const HTML_IMAGE = /<(?:img|source|image)\b[^>]*>/giu
const DEFINITION = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*<?(\S+?)>?(?:[ \t]+[^\n]*)?$/gmu
// Full, collapsed and shortcut forms: `![a][r]`, `![a][]`, `![a]`.
const IMAGE_REFERENCE = new RegExp(String.raw`!\[${LABEL}\](?:\[([^\]\n]*)\])?`, 'gu')
const AUTOLINK = /<([a-z][a-z0-9+.-]*:\/\/[^\s>]+)>/giu
const BARE = /\b(?:https?|ftp):\/\/[^\s<>()[\]"'`]+/giu

/**
 * Every address in the answer, once. Earlier patterns win an overlap: the
 * address inside `![a](url)` is not found again as a bare link.
 */
function candidates(answer: string): Candidate[] {
  const taken: Array<[number, number]> = []
  const result: Candidate[] = []
  const add = (candidate: Candidate): void => {
    if (taken.some(([start, end]) => candidate.start < end && start < candidate.end)) return
    taken.push([candidate.start, candidate.end])
    result.push(candidate)
  }

  for (const match of answer.matchAll(INLINE_IMAGE)) {
    add({ kind: 'image', url: match[2]!, start: match.index, end: match.index + match[0].length, text: match[1]! })
  }
  for (const match of answer.matchAll(HTML_IMAGE)) {
    // Every address in the tag: src, srcset, data-src, href. One unnamed
    // address is enough for the fetch, so the tag goes whole.
    for (const address of match[0].matchAll(/(?:[a-z][a-z0-9+.-]*:|&#0*58;|&#x0*3a;|&colon;)?\/\/[^\s"'<>,]+/giu)) {
      add({ kind: 'image', url: address[0], start: match.index, end: match.index + match[0].length, text: '' })
    }
  }
  // A reference definition is where a reference-style image gets its
  // address; the definition line is what goes.
  const imageLabels = new Set([...answer.matchAll(IMAGE_REFERENCE)].map((match) => (match[2] || match[1]!).toLowerCase()))
  for (const match of answer.matchAll(DEFINITION)) {
    const kind = imageLabels.has(match[1]!.toLowerCase()) ? 'image' : 'link'
    add({ kind, url: match[2]!, start: match.index, end: match.index + match[0].length, text: '' })
  }
  for (const match of answer.matchAll(INLINE_LINK)) {
    add({ kind: 'link', url: match[2]!, start: match.index, end: match.index + match[0].length, text: match[1]! })
  }
  for (const match of answer.matchAll(AUTOLINK)) {
    add({ kind: 'link', url: match[1]!, start: match.index, end: match.index + match[0].length, text: '' })
  }
  for (const match of answer.matchAll(BARE)) {
    // Sentence punctuation sticks to a bare address and is not part of it.
    const url = match[0].replace(/[.,;:!?]+$/u, '')
    add({ kind: 'link', url, start: match.index, end: match.index + url.length, text: '' })
  }
  const code = codeRanges(answer)
  return result
    // Inside code nothing is rendered or fetched, and cutting there would
    // destroy an example.
    .filter((candidate) => !code.some(([start, end]) => candidate.start < end && start < candidate.end))
    // A renderer decodes character references before it reads the scheme:
    // `https&#58;//evil.example` is fetched like `https://evil.example`.
    .map((candidate) => ({ ...candidate, url: decodeEntities(candidate.url) }))
    .filter((candidate) => /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate.url) || candidate.url.startsWith('//'))
}

/**
 * Fenced blocks and inline code spans. An unclosed fence runs to the end, as
 * a renderer reads it.
 */
function codeRanges(answer: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gmu
  let open: { at: number; marker: string } | null = null
  for (const match of answer.matchAll(fence)) {
    const marker = match[1]!
    if (open === null) open = { at: match.index, marker }
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      ranges.push([open.at, match.index + match[0].length])
      open = null
    }
  }
  if (open !== null) ranges.push([open.at, answer.length])
  for (const match of answer.matchAll(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/gu)) {
    if (!ranges.some(([start, end]) => match.index >= start && match.index < end)) {
      ranges.push([match.index, match.index + match[0].length])
    }
  }
  return ranges
}

const NAMED: Readonly<Record<string, string>> = { colon: ':', sol: '/', period: '.', quest: '?', amp: '&', num: '#', equals: '=' }

function decodeEntities(url: string): string {
  return url.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/giu, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return String.fromCodePoint(Math.min(Number(dec), 0x10ffff))
    if (hex !== undefined) return String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff))
    return NAMED[name!.toLowerCase()] ?? whole
  })
}

/**
 * Whether a link's address carries something beyond a place.
 *
 * A query is data by construction. A fragment never reaches the server, but
 * the page's script reads it, so one shaped like data counts. A path segment
 * counts when it looks like an identifier or an encoding rather than a word:
 * `/c/a8f3k29dm4x7q1z0`, not `/3/library/os.html`.
 */
function carriesData(url: string): boolean {
  const hash = url.indexOf('#')
  const fragment = hash < 0 ? '' : url.slice(hash + 1)
  const beforeHash = hash < 0 ? url : url.slice(0, hash)
  const question = beforeHash.indexOf('?')
  if (question >= 0 && question < beforeHash.length - 1) return true
  if (dataLike(fragment, 8) || fragment.length >= 32) return true
  // Userinfo is sent to the host along with the request.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu.test(url)) return true
  const path = (question < 0 ? beforeHash : beforeHash.slice(0, question)).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu, '')
  return path.split('/').some((segment) => dataLike(segment.replace(/\.[a-z0-9]{1,5}$/iu, ''), 12) || segment.length >= 48)
}

function dataLike(segment: string, min: number): boolean {
  return segment.length >= min && /\d/u.test(segment) && /[a-z]/iu.test(segment) && /^[\w+=%.~-]+$/u.test(segment)
}

/**
 * The host, for the note. Only host characters are kept, so an address like
 * `https://evil.example](x)` cannot draw markdown of its own into the note.
 */
function hostOf(url: string): string {
  const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#\s]*)/iu.exec(url)?.[1] ?? ''
  const host = /^[a-z0-9.:-]*/iu.exec(authority.replace(/^[^@]*@/u, ''))?.[0] ?? ''
  return host.replace(/[.:]+$/u, '').toLowerCase() || 'an address'
}

/**
 * The warning for a transport that sees the answer only on its way to the
 * screen and cannot take it back. Hosts are already reduced to host
 * characters, so an address cannot draw a line of its own here.
 */
export function renderOutbound(found: readonly Outbound[]): string {
  if (found.length === 0) return ''
  const listed = [...new Set(found.map((item) => `${item.host} (${item.kind})`))]
  return [
    '',
    'Cordon: this answer was written after an untrusted read and carries addresses that would send data out when shown or opened:',
    `  - ${listed.slice(0, 8).join(', ')}${listed.length > 8 ? `, and ${listed.length - 8} more` : ''}`,
    'An image loads by itself in a viewer that renders markdown; do not open these links, and do not paste this answer into one.',
  ].join('\n')
}
