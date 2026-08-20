import type { Source } from '../core/types.js'

export interface Subject {
  /** The domain without www and service subdomains. */
  host: string
  /** The names the subject is called in the text, longest first. */
  names: string[]
}

/**
 * Syndication domains: the subject writes the text and somebody else's
 * platform publishes it. The check "the domain differs from the subject" is
 * fooled by them by construction, so they are named in a list.
 */
const SYNDICATION: ReadonlySet<string> = new Set([
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'newswire.com',
  'accesswire.com',
  'einpresswire.com',
  'openpr.com',
  'prweb.com',
])

/** Subdomains that do not change whose site it is. */
const SERVICE_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www', 'blog', 'news', 'docs', 'help', 'support', 'shop', 'store', 'm', 'ru', 'en',
])

/**
 * Words that name nobody when they appear in text.
 *
 * A domain made of one such word does not count as the subject's name:
 * "shop" and "news" occur in text on their own, and the mark "only the source
 * itself testifies about it" would fall on a source for nothing. A subject
 * with such a name stays recognizable by its full domain, and if that did not
 * make it into the text either, the third axis stays silent. Silence here is
 * cheaper than a false mark.
 */
const GENERIC_NAMES: ReadonlySet<string> = new Set([
  ...SERVICE_SUBDOMAINS,
  'mail', 'app', 'web', 'site', 'home', 'cloud', 'info', 'online', 'group', 'company',
])

/** Second-level domains with one more part of the name behind them. */
const SECOND_LEVEL: ReadonlySet<string> = new Set([
  'co.uk', 'com.br', 'com.au', 'co.jp', 'com.tr', 'co.in', 'com.cn', 'com.mx',
])

/**
 * A name shorter than three characters is not taken: a two-letter piece of a
 * domain occurs in ordinary text as part of a word, and a mark based on it
 * would fire out of nowhere.
 */
const MIN_NAME = 3

function hostOf(label: string): string | null {
  try {
    const url = new URL(label)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** Strips a service subdomain, preserving second-level domains. */
function trim(host: string): string {
  const parts = host.split('.')
  const tail = parts.slice(-2).join('.')
  const keep = SECOND_LEVEL.has(tail) ? 3 : 2
  while (parts.length > keep && SERVICE_SUBDOMAINS.has(parts[0] ?? '')) parts.shift()
  return parts.length > keep ? parts.slice(-keep).join('.') : parts.join('.')
}

export function isSyndication(host: string): boolean {
  return SYNDICATION.has(trim(host.toLowerCase()))
}

/**
 * The name a source may be called by in the text.
 *
 * From the domain only, and deliberately so. Extracting names from arbitrary
 * text means guessing, and a guess in a footer about trust is worse than
 * silence.
 */
export function subjectOf(source: Source): Subject | null {
  const raw = hostOf(source.label)
  if (!raw) return null

  const host = trim(raw)
  const names = [host]
  const head = host.split('.')[0] ?? ''
  if (head.length >= MIN_NAME && !GENERIC_NAMES.has(head)) {
    names.push(head)
    const squashed = head.replace(/[^a-z0-9]/gu, '')
    if (squashed !== head && squashed.length >= MIN_NAME) names.push(squashed)
  }
  return { host, names }
}
