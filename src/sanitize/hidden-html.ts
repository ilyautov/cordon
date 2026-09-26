import { Parser } from 'htmlparser2'
import { type Finding, sample } from './types.js'

const HIDDEN_STYLE =
  /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?!\.[1-9])|opacity\s*:\s*0(?!\.[1-9]))/i

/**
 * Moving off-screen and clipping to nothing: the .sr-only recipe rewritten as
 * an inline style. The thresholds are deliberately large (hundreds for text
 * indent, thousands for offsets): small negative shifts like margin-left:-2px
 * are ordinary layout and must not be caught.
 *
 * A clip counts only when it leaves nothing visible. `rect()` with every side
 * at 0 or 1px — the pattern once matched any rect starting at 0, and so ate
 * `rect(0px, 640px, 360px, 0px)`, a banner cropped in plain view, while
 * missing the classic `rect(1px,1px,1px,1px)`. `inset()` with every value at
 * 50% or more, which meets in the middle — the pattern once knew only 100%,
 * and the battery measured 99% walking through.
 */
const OFFSCREEN_STYLE =
  /(text-indent\s*:\s*-\d{3,}|(?:left|top|right|bottom|margin-left|margin-top)\s*:\s*-\d{4,}|clip\s*:\s*rect\(\s*(?:[01](?:px)?[\s,]*){4}\)|clip-path\s*:\s*inset\(\s*(?:(?:[5-9]\d(?:\.\d+)?|100)%\s*){1,4}\))/i

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'NOSCRIPT', 'TEMPLATE'])

/**
 * Classes that exist to hide text from sighted readers and keep it for screen
 * readers: Tailwind, Bootstrap 5 and 4, WordPress, Drupal, and the common
 * hand-rolled names. The same recipe written inline is already cut; written
 * as a class it was never looked at.
 *
 * `hidden`, `d-none` and `invisible` are deliberately absent: they hide menus,
 * tabs and dialogs that a script opens, and `hidden md:flex` is visible on
 * any desktop. That is interface state, not a message kept from the reader.
 */
const SCREEN_READER_CLASSES: ReadonlySet<string> = new Set([
  'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screen-reader-only',
  'element-invisible', 'a11y-hidden', 'assistive-text', 'hidden-visually', 'sr-only-focusable',
])

/**
 * How long one screen-reader text may be before it reads as a message rather
 * than a label. Honest labels are short: "Skip to content", "(opens in a new
 * tab)", a post title after "Continue reading". Judged per span: summing a
 * page's labels caught a plain product page, and joining neighbouring spans
 * caught a pagination list. An instruction split into short spans without a
 * destination passes; that limit is written down in docs/install.md.
 */
const SCREEN_READER_WORDS = 12

/**
 * A destination: a link, an address or a path. An exfiltration needs one, and
 * an honest label almost never carries one, so a single one is enough.
 */
const DESTINATION = /https?:\/\/|www\.|[\w.-]+@[\w-]+\.[a-z]{2,}|(?:^|\s)~?\/[\w.-]+\//iu

/**
 * Raw-text tags: an unclosed one of these swallows the entire rest of the
 * input. That is exactly why a mention of `<style>` in technical
 * documentation would cost the reader all the text below the mention rather
 * than one extra finding.
 */
const RAW_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

/**
 * The stand-in mark for a masked mention: a private-use character the input
 * does not already contain. HTML parsing treats it as an ordinary letter.
 *
 * Chosen per input rather than fixed. With one fixed mark, an input already
 * holding it had to be left unmasked — restoring would have turned the
 * original character into an angle bracket — and review found what that
 * costs: one private-use character ahead of an unclosed `<style>` switched
 * the guard off, and the raw block swallowed everything below it. A pair is
 * the fallback for an input that holds every single private-use character.
 */
function mentionMark(source: string): string {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const mark = String.fromCharCode(code)
    if (!source.includes(mark)) return mark
  }
  for (let first = 0xe000; first <= 0xf8ff; first++) {
    for (let second = 0xe000; second <= 0xf8ff; second++) {
      const mark = String.fromCharCode(first, second)
      if (!source.includes(mark)) return mark
    }
  }
  // Unreachable for any input under a gigabyte of distinct pairs; failing
  // loudly here is a refusal upstream, never a silently swallowed document.
  throw new Error('no private-use mark is free in this input')
}

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
function maskUnclosedRawTags(source: string, mark: string): string {
  let masked = source
  for (const tag of RAW_TEXT_TAGS) {
    const name = tag.toLowerCase()
    if (hasClosingTag(source, name)) continue
    masked = masked.replace(new RegExp(`<(?=${name}[\\s>/])`, 'gi'), mark)
  }
  return masked
}

/** Gives masked mentions their angle bracket back. */
function unmask(text: string, mark: string): string {
  return text.includes(mark) ? text.replaceAll(mark, '<') : text
}

const REPORT_ATTRS = ['alt', 'title'] as const

/**
 * Attributes whose value is text for a machine and never for the reader.
 *
 * The page shows nothing, the model reads every word: this is the first trick
 * in the book and it used to go through untouched. `alt` and `title` are
 * deliberately not here — they are flagged above and left in place, because
 * an image description is often the only description there is, and cutting it
 * costs the reader real content.
 *
 * `data-*` is a family rather than a list: the point of the prefix is that
 * anyone may invent a name under it.
 */
const HIDDEN_TEXT_ATTRS: ReadonlySet<string> = new Set([
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder',
  'aria-valuetext', 'aria-details', 'placeholder', 'srcdoc', 'abbr',
])

/**
 * Whether an attribute's value is worth cutting out.
 *
 * An instruction needs words. Requiring two of them, or a value long enough
 * to hold a sentence, keeps `data-id="12"` and `data-index="3"` where they
 * are: those are on nearly every page, and removing them would be a change
 * with no defence in it.
 */
function carriesProse(value: string): boolean {
  return /\w\s+\w/u.test(value) || value.trim().length >= 40
}

function hidesTextFrom(tag: string, name: string, attrs: Record<string, string>): boolean {
  if (HIDDEN_TEXT_ATTRS.has(name) || name.startsWith('data-')) return true
  // A hidden input is a field the reader never sees and the model reads like
  // any other text.
  return tag === 'INPUT' && name === 'value' && attrs['type']?.trim().toLowerCase() === 'hidden'
}

interface AttrSpan {
  name: string
  /** Offsets within the opening tag, whitespace before the name included. */
  start: number
  end: number
}

/**
 * The attributes of one opening tag, with the offsets they occupy in it.
 *
 * Written out rather than found with a regular expression on purpose: an
 * attribute name occurring inside another attribute's value — `title="see
 * data-note=x"` — is exactly what a pattern would match, and cutting by that
 * offset would take a bite out of the middle of the tag. The scan is over one
 * bounded string and respects quoting, so it cannot land inside a value.
 */
function attributeSpans(tag: string): AttrSpan[] {
  const spans: AttrSpan[] = []
  let at = 1
  while (at < tag.length && !/[\s/>]/u.test(tag[at] ?? '>')) at++

  while (at < tag.length) {
    const before = at
    while (at < tag.length && /\s/u.test(tag[at] ?? '')) at++
    const char = tag[at]
    if (char === undefined || char === '>' || char === '/') break

    const nameAt = at
    while (at < tag.length && !/[\s=/>]/u.test(tag[at] ?? '>')) at++
    const name = tag.slice(nameAt, at).toLowerCase()

    while (at < tag.length && /\s/u.test(tag[at] ?? '')) at++
    if (tag[at] === '=') {
      at++
      while (at < tag.length && /\s/u.test(tag[at] ?? '')) at++
      const quote = tag[at]
      if (quote === '"' || quote === "'") {
        at++
        while (at < tag.length && tag[at] !== quote) at++
        at++
      } else {
        while (at < tag.length && !/[\s>]/u.test(tag[at] ?? '>')) at++
      }
    }

    if (name !== '') spans.push({ name, start: before, end: at })
  }

  return spans
}

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
function isInvisibleByColor(style: string, pageHasBackground: boolean): boolean {
  const declarations = parseDeclarations(style)
  const color = normalizeColor(declarations.get('color'))
  if (!color) return false
  if (color === 'transparent') return true

  const background =
    normalizeColor(declarations.get('background-color')) ??
    colorFromShorthand(declarations.get('background'))
  if (background !== null) return background === color

  // No background on the element, and none anywhere in the document: what is
  // behind the text is the client's default, and that is white. White on
  // white was the textbook trick and it walked past this check, because the
  // check waited for a background nobody had to declare.
  //
  // The condition is deliberately narrow. A page that sets a background
  // somewhere may well set a dark one, and white text on it is ordinary
  // design — cutting that would take real content away from the reader.
  return !pageHasBackground && isNearWhite(color)
}

/** Declared anywhere at all: an attribute, an inline style, a style block. */
const BACKGROUND_DECLARED = /background(-color)?\s*:|bgcolor\s*=/iu

function isNearWhite(color: string): boolean {
  const channels = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16))
  return channels.every((value) => value >= 0xf0)
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
  /** Hidden by a screen-reader class: the verdict depends on the whole page. */
  screenReader?: boolean
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
 * Class names a document's own stylesheet hides outright.
 *
 * Only top-level rules whose selector list is nothing but plain classes are
 * read. A rule inside `@media` or `@supports` applies to some screens and not
 * others (print-only footers are the usual case), and a compound selector
 * depends on a structure this pass does not model. Reading less keeps the
 * answer certain: what is collected here is hidden on every screen.
 */
function stylesheetHiddenClasses(source: string): { hidden: Set<string>; judged: Set<string> } {
  const hidden = new Set<string>()
  const conditional = new Set<string>()
  for (const block of source.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/giu)) {
    const css = (block[1] ?? '').replace(/\/\*[\s\S]*?\*\//gu, '')
    // A class the sheet styles again inside an at-rule may be shown
    // somewhere: `.print-footer{display:none}` with
    // `@media print{.print-footer{display:block}}` is an honest print-only
    // line. It may also be shown nowhere a reader looks: print, or a
    // breakpoint no screen has. So such a class is not cut outright and not
    // trusted either: its spans are judged like a screen-reader span.
    for (const match of css.matchAll(/@[^{]+\{([\s\S]*?)\}\s*\}/gu)) {
      for (const name of (match[1] ?? '').matchAll(/\.([\w-]+)/gu)) conditional.add((name[1] ?? '').toLowerCase())
    }
    for (const { selector, body } of topLevelRules(css)) {
      const selectors = selector.split(',').map((part) => part.trim())
      if (!selectors.every((one) => /^\.[\w-]+$/u.test(one))) continue
      if (!HIDDEN_STYLE.test(body) && !OFFSCREEN_STYLE.test(body)) continue
      for (const one of selectors) hidden.add(one.slice(1).toLowerCase())
    }
  }
  const judged = new Set<string>()
  for (const name of conditional) {
    if (hidden.delete(name)) judged.add(name)
  }
  return { hidden, judged }
}

/**
 * The rules at the top level of a stylesheet, by brace depth. An at-rule's
 * block is skipped whole with everything nested in it, and so is a rule
 * whose body nests further, since neither holds on every screen.
 */
function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = []
  let depth = 0
  let head = ''
  let body = ''
  let nested = false
  for (const char of css) {
    if (char === '{') {
      depth++
      if (depth > 1) nested = true
      else continue
    } else if (char === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        const selector = head.trim()
        if (!nested && !selector.startsWith('@')) rules.push({ selector, body })
        head = ''
        body = ''
        nested = false
        continue
      }
    }
    if (depth === 0) {
      if (char === ';' && head.trim().startsWith('@')) head = ''
      else head += char
    } else body += char
  }
  // A browser closes a block left open at the end of the sheet, so a rule
  // missing its last brace still applies.
  const selector = head.trim()
  if (depth === 1 && !nested && selector !== '' && !selector.startsWith('@')) rules.push({ selector, body })
  return rules
}

function classesOf(attrs: Record<string, string>): string[] {
  return (attrs['class'] ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
}

/** Whether a stylesheet's text carries anything beyond rules: prose in its comments. */
function stylesheetProse(css: string): string | null {
  const comments = [...css.matchAll(/\/\*([\s\S]*?)\*\//gu)].map((match) => (match[1] ?? '').trim())
  const prose = comments.filter((comment) => /\w\s+\w/u.test(comment))
  return prose.length > 0 ? prose.join(' ') : null
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

  const mark = mentionMark(withoutComments)
  const source = maskUnclosedRawTags(withoutComments, mark)
  const pageHasBackground = BACKGROUND_DECLARED.test(input)
  const { hidden: classHidden, judged: classJudged } = stylesheetHiddenClasses(source)
  // Screen-reader spans wait for the end of the page: whether they are labels
  // or a message is a question about all of them together.
  const screenReader: Array<{ span: readonly [number, number]; text: string; className: string }> = []
  let screenReaderDepth = 0
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
        // Counted like any other child of a screen-reader span: its close
        // takes a level, and without this an empty `<style></style>` inside
        // the span spent the span's own level and switched its check off.
        if (screenReaderDepth > 0) screenReaderDepth++
        frame.candidate = true
        frame.text = []
        sinks.push(frame)
        return
      }

      const style = attrs['style'] ?? ''
      const classes = classesOf(attrs)
      const hidden =
        classes.some((name) => classHidden.has(name)) ||
        attrs['hidden'] !== undefined ||
        attrs['aria-hidden']?.trim().toLowerCase() === 'true' ||
        HIDDEN_STYLE.test(style) ||
        OFFSCREEN_STYLE.test(style) ||
        isInvisibleByColor(style, pageHasBackground)

      if (hidden) {
        frame.doomed = true
        frame.text = []
        sinks.push(frame)
        doomedDepth = 1
        return
      }

      const readerClass = classes.find((name) => SCREEN_READER_CLASSES.has(name) || classJudged.has(name))
      if (readerClass !== undefined && screenReaderDepth === 0) {
        frame.screenReader = true
        frame.fallback = readerClass
        frame.text = []
        sinks.push(frame)
        screenReaderDepth = 1
      } else if (screenReaderDepth > 0) {
        screenReaderDepth++
      }

      for (const attr of REPORT_ATTRS) {
        const value = attrs[attr]
        if (value && value.trim()) {
          findings.push({ kind: 'annotation', detail: `attr:${attr}`, sample: sample(value) })
        }
      }

      // The value is cut out of the tag rather than the tag rewritten: the
      // rest of the document, this tag included, stays byte for byte what it
      // was. Only the attributes actually carrying words are touched.
      const carriers = Object.keys(attrs).filter(
        (name) => hidesTextFrom(tag, name, attrs) && carriesProse(attrs[name] ?? ''),
      )
      if (carriers.length === 0) return

      const from = parser.startIndex
      const tagText = source.slice(from, parser.endIndex + 1)
      for (const span of attributeSpans(tagText)) {
        if (!carriers.includes(span.name)) continue
        findings.push({
          kind: 'hidden-html',
          detail: `attr:${span.name}`,
          sample: sample(attrs[span.name] ?? '', 512),
        })
        cuts.push([from + span.start, from + span.end])
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

      if (screenReaderDepth > 0) {
        screenReaderDepth--
        if (frame.screenReader) {
          screenReader.push({ span, text: (frame.text ?? []).join(''), className: frame.fallback })
        }
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
      if (frame.tag === 'STYLE') {
        // A stylesheet is cut, since the model has no use for it, but it is
        // not a hidden message: every real page carries one, and reporting it
        // taught the reader to skip the report. What is reported is prose
        // tucked into its comments.
        cuts.push(span)
        const prose = stylesheetProse(payload)
        if (prose !== null) findings.push({ kind: 'hidden-html', detail: 'tag:style', sample: sample(prose, 512) })
        return
      }
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

  const labels: string[] = []
  for (const entry of screenReader) {
    const text = entry.text.replace(/\s+/gu, ' ').trim()
    if (!text) continue
    const message = text.split(' ').length > SCREEN_READER_WORDS || DESTINATION.test(text)
    if (!message) {
      labels.push(text)
      continue
    }
    findings.push({ kind: 'hidden-html', detail: `class:${entry.className}`, sample: sample(text, 512) })
    cuts.push(entry.span)
  }
  if (labels.length > 0) {
    findings.push({ kind: 'annotation', detail: 'class:screen-reader', sample: sample([...new Set(labels)].join(' | ')) })
  }

  return {
    clean: unmask(cutOut(source, cuts), mark),
    findings: findings.map((finding) => ({ ...finding, sample: unmask(finding.sample, mark) })),
  }
}
