import { Parser } from 'htmlparser2'
import { type Finding, sample } from './types.js'

const HIDDEN_STYLE =
  /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?!\.[1-9])|opacity\s*:\s*0(?!\.[1-9]))/i

/**
 * Moving off-screen and clipping to zero: the .sr-only recipe rewritten as an
 * inline style. The thresholds are deliberately large (hundreds for text
 * indent, thousands for offsets): small negative shifts like margin-left:-2px
 * are ordinary layout and must not be caught.
 */
const OFFSCREEN_STYLE =
  /(text-indent\s*:\s*-\d{3,}|(?:left|top|right|bottom|margin-left|margin-top)\s*:\s*-\d{4,}|clip\s*:\s*rect\(\s*0|clip-path\s*:\s*inset\(\s*100%)/i

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'NOSCRIPT', 'TEMPLATE'])

/**
 * Raw-text tags: an unclosed one of these swallows the entire rest of the
 * input. That is exactly why a mention of `<style>` in technical
 * documentation would cost the reader all the text below the mention rather
 * than one extra finding.
 */
const RAW_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

/**
 * The stand-in mark for a masked mention. A private-use character was chosen
 * because it never occurs in meaningful text, while HTML parsing treats it as
 * an ordinary letter.
 */
const MENTION_MARK = '\uE000'

/** A closing tag in the source text. */
function hasClosingTag(source: string, tag: string): boolean {
  return new RegExp(`</${tag}\\s*>`, 'i').test(source)
}

/**
 * Hides opening raw-text tags with no closing tag from the parser.
 *
 * Without this, a mention of `<style>` in technical documentation costs the
 * reader all the text below the mention: an unclosed raw block swallows the
 * rest of the input, and that rest leaves the cleaned text together with the
 * block. The absence of a closing tag is precisely the signal of a mention: a
 * real page closes a raw block, otherwise the browser hides the whole
 * document below it from the human.
 *
 * The price of this decision is named in the README: an unclosed `<script>`
 * on a real page stays in the text. It is lower than the price of the reverse
 * error, that is, silently discarding half of a legitimate document on every
 * mention of a tag.
 */
function maskUnclosedRawTags(source: string): string {
  // Input that already contains the stand-in mark is left alone entirely:
  // restoring it would put an extra angle bracket in its place.
  if (source.includes(MENTION_MARK)) return source

  let masked = source
  for (const tag of RAW_TEXT_TAGS) {
    const name = tag.toLowerCase()
    if (hasClosingTag(source, name)) continue
    masked = masked.replace(new RegExp(`<(?=${name}[\\s>/])`, 'gi'), MENTION_MARK)
  }
  return masked
}

/** Gives masked mentions their angle bracket back. */
function unmask(text: string): string {
  return text.includes(MENTION_MARK) ? text.replaceAll(MENTION_MARK, '<') : text
}

const REPORT_ATTRS = ['alt', 'title'] as const

/** Only the names that actually turn up in the text-in-background-colour attack. */
const NAMED_COLORS: ReadonlyMap<string, string> = new Map([
  ['white', '#ffffff'],
  ['black', '#000000'],
  ['silver', '#c0c0c0'],
  ['gray', '#808080'],
  ['grey', '#808080'],
  ['whitesmoke', '#f5f5f5'],
  ['ivory', '#fffff0'],
  ['snow', '#fffafa'],
])

/** Normalizes a colour to #rrggbb or 'transparent'; null means not a colour. */
function normalizeColor(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return null
  if (value === 'transparent') return 'transparent'

  const named = NAMED_COLORS.get(value)
  if (named) return named

  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex) {
    const digits = hex[1] ?? ''
    if (digits.length === 3 || digits.length === 4) {
      const alpha = digits.length === 4 ? digits[3] : 'f'
      if (alpha === '0') return 'transparent'
      return '#' + [...digits.slice(0, 3)].map((c) => c + c).join('')
    }
    if (digits.length === 6) return `#${digits}`
    if (digits.length === 8) return digits.slice(6) === '00' ? 'transparent' : `#${digits.slice(0, 6)}`
    return null
  }

  const rgb = /^rgba?\(([^)]*)\)$/.exec(value)
  if (rgb) {
    const parts = (rgb[1] ?? '').split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const alpha = parts[3]
    if (alpha !== undefined && Number(alpha) === 0) return 'transparent'
    const channels = parts.slice(0, 3).map((part) => Number(part.replace('%', '')))
    if (channels.some(Number.isNaN)) return null
    return '#' + channels.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')
  }

  return null
}

/** Parses an inline style into property/value pairs. */
function parseDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const chunk of style.split(';')) {
    const colon = chunk.indexOf(':')
    if (colon === -1) continue
    declarations.set(chunk.slice(0, colon).trim().toLowerCase(), chunk.slice(colon + 1).trim())
  }
  return declarations
}

/** Extracts the colour from the background shorthand: it may sit among url() and repeat values. */
function colorFromShorthand(value: string | undefined): string | null {
  if (!value) return null
  const whole = normalizeColor(value)
  if (whole) return whole
  for (const token of value.split(/\s+/)) {
    const color = normalizeColor(token)
    if (color) return color
  }
  return null
}

/**
 * Text in the same colour as the background, or fully transparent.
 * The background must be declared right here: white text without a declared
 * background is also the ordinary layout of a dark section where the
 * background comes from a class, and catching it would mean showering normal
 * pages with findings.
 */
function isInvisibleByColor(style: string): boolean {
  const declarations = parseDeclarations(style)
  const color = normalizeColor(declarations.get('color'))
  if (!color) return false
  if (color === 'transparent') return true

  const background =
    normalizeColor(declarations.get('background-color')) ??
    colorFromShorthand(declarations.get('background'))
  return background !== null && background === color
}

/**
 * An element that is open during parsing.
 *
 * Parsing is streaming, so the removal decision and the text for the report
 * are separated in time: a hidden element is visible from its attributes
 * immediately, while its content arrives later. Marks in the findings and cut
 * lists make it possible to roll back everything accumulated inside an
 * element when it does end up removed.
 */
interface Frame {
  /** The tag name in upper case, as in DROP_TAGS. */
  tag: string
  /** Offset of the opening tag within the parser's input. */
  start: number
  /** Text pieces of this element and its descendants; null means text is not needed. */
  text: string[] | null
  /** content and value, for the report's fallback. */
  fallback: string
  /** Length of findings at the moment of opening. */
  findingMark: number
  /** Length of cuts at the moment of opening. */
  cutMark: number
  /** The element is already doomed: descendants are not checked. */
  doomed: boolean
  /** A DROP_TAGS element: the verdict depends on its content. */
  candidate: boolean
}

/**
 * Content for the report. In meta and input the payload sits in an attribute
 * rather than in the text: without a fallback, a human reviewing an incident
 * would see the fact of removal without a single word about the content.
 */
function payloadOf(frame: Frame): string {
  const text = (frame.text ?? []).join('')
  if (text.trim()) return text
  return frame.fallback
}

/** Cuts ranges out of a string; the ranges must not overlap. */
function cutOut(source: string, cuts: ReadonlyArray<readonly [number, number]>): string {
  if (cuts.length === 0) return source
  const sorted = [...cuts].sort((a, b) => a[0] - b[0])
  const parts: string[] = []
  let at = 0
  for (const [from, to] of sorted) {
    if (from < at) continue
    parts.push(source.slice(at, from))
    at = to
  }
  parts.push(source.slice(at))
  return parts.join('')
}

/**
 * Removes from HTML whatever is hidden from the human but visible to the
 * model. The alt and title attributes are flagged but NOT removed: they are
 * often legitimate, and cutting them would damage usefulness.
 *
 * The cleaned text is assembled by cutting ranges out of the input rather
 * than by re-serializing a tree. The difference is not cosmetic:
 * re-serialization rewrites the entire document even when there is nothing to
 * hide, that is, it changes quotes, case and whitespace in places where
 * Cordon found nothing. Cutting leaves everything else byte for byte the
 * same.
 *
 * Parsing is streaming for the same reason the hook has a timeout. Tree-based
 * parsing grew quadratically, and megabytes of empty text on a page pushed
 * the hook past its timeout, while an expired hook on Claude Code means a
 * pass. That is, page size was a way to switch the defence off, and it cost
 * the attacker a few megabytes of ballast.
 */
export function stripHiddenHtml(input: string): { clean: string; findings: Finding[] } {
  if (!input.includes('<')) return { clean: input, findings: [] }

  const findings: Finding[] = []

  // Comments are removed before parsing: the vector is simple, and the
  // parser delivers them as a separate event that costs more to handle than
  // this replacement.
  const withoutComments = input.replace(/<!--([\s\S]*?)-->/g, (_match, body: string) => {
    if (body.trim()) {
      findings.push({ kind: 'hidden-html', detail: 'comment', sample: sample(body, 512) })
    }
    return ''
  })

  const source = maskUnclosedRawTags(withoutComments)
  const cuts: Array<readonly [number, number]> = []
  const stack: Frame[] = []
  // The stack of frames that collect text: one buffer each, so a
  // descendant's text also reaches an ancestor that needs it for the report.
  const sinks: Frame[] = []
  let doomedDepth = 0

  let parser: Parser

  const handlers = {
    onopentag(name: string, attrs: Record<string, string>) {
      const tag = name.toUpperCase()
      const frame: Frame = {
        tag,
        start: parser.startIndex,
        text: null,
        fallback: attrs['content'] ?? attrs['value'] ?? '',
        findingMark: findings.length,
        cutMark: cuts.length,
        doomed: false,
        candidate: false,
      }
      stack.push(frame)

      // Nothing is checked inside a doomed element: it leaves whole together
      // with its descendants, and findings about them would be findings about
      // text the model will never see.
      if (doomedDepth > 0) {
        doomedDepth++
        return
      }

      if (DROP_TAGS.has(tag)) {
        frame.candidate = true
        frame.text = []
        sinks.push(frame)
        return
      }

      const style = attrs['style'] ?? ''
      const hidden =
        attrs['hidden'] !== undefined ||
        attrs['aria-hidden']?.trim().toLowerCase() === 'true' ||
        HIDDEN_STYLE.test(style) ||
        OFFSCREEN_STYLE.test(style) ||
        isInvisibleByColor(style)

      if (hidden) {
        frame.doomed = true
        frame.text = []
        sinks.push(frame)
        doomedDepth = 1
        return
      }

      for (const attr of REPORT_ATTRS) {
        const value = attrs[attr]
        if (value && value.trim()) {
          findings.push({ kind: 'annotation', detail: `attr:${attr}`, sample: sample(value) })
        }
      }
    },

    ontext(text: string) {
      const sink = sinks[sinks.length - 1]
      if (sink?.text) sink.text.push(text)
    },

    onclosetag(_name: string, implied: boolean) {
      const frame = stack.pop()
      if (!frame) return

      // An explicitly closed element ends at its own closing tag. An
      // implicitly closed one ends where the tag that closed it began: for
      // such a close, endIndex points at the end of somebody else's tag, and
      // cutting by it ate the neighbour. The list `<li>one<li hidden>x<li>
      // three` lost the third `<li>`, and an unclosed paragraph before
      // `</div>` would have taken `</div>` with it.
      //
      // Void elements such as `<meta>` also close implicitly, but the tag to
      // blame is the element itself. That is exactly the difference: another
      // tag starts after the element's start, its own coincides with it.
      const closedByOther = implied && parser.startIndex > frame.start
      const span = [frame.start, closedByOther ? parser.startIndex : parser.endIndex + 1] as const

      if (frame.text) {
        sinks.pop()
        const outer = sinks[sinks.length - 1]
        if (outer?.text) outer.text.push(frame.text.join(''))
      }

      if (frame.doomed) {
        doomedDepth = 0
        findings.length = frame.findingMark
        cuts.length = frame.cutMark
        findings.push({
          kind: 'hidden-html',
          detail: 'hidden-element',
          sample: sample(payloadOf(frame), 512),
        })
        cuts.push(span)
        return
      }

      if (doomedDepth > 0) {
        doomedDepth--
        return
      }

      if (!frame.candidate) return

      // An empty block has nothing to hide: `<meta>` without content and
      // `<script src>` carry not a single word for the model, whereas
      // `<meta>` in text about markup turns up on every other documentation
      // page.
      const payload = payloadOf(frame)
      if (!payload.trim()) return

      findings.length = frame.findingMark
      cuts.length = frame.cutMark
      findings.push({
        kind: 'hidden-html',
        detail: `tag:${frame.tag.toLowerCase()}`,
        sample: sample(payload, 512),
      })
      cuts.push(span)
    },
  }

  parser = new Parser(handlers, {
    // Decoded entities are needed for detection: `display&#58;none`
    // in an attribute would otherwise slip past. This does not affect the
    // cleaned text, because that is cut out of the input rather than
    // reassembled.
    decodeEntities: true,
  })
  parser.write(source)
  parser.end()

  return {
    clean: unmask(cutOut(source, cuts)),
    findings: findings.map((finding) => ({ ...finding, sample: unmask(finding.sample) })),
  }
}
