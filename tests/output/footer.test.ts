import { describe, expect, it } from 'vitest'
import { renderFooter } from '../../src/output/footer.js'

describe('the footer about the influence of sources', () => {
  it('shows the shared fragment so the human sees for themselves what the text is', () => {
    const text = renderFooter({
      influences: [],
      kinship: [
        {
          labels: ['https://law-a.example/analysis', 'https://lawyer-b.example/column'],
          excerpt: 'The operator is obliged to ensure the recording and storage of personal data',
        },
      ],
      truncated: false,
    })
    expect(text).toContain('not independent')
    expect(text).toContain('The operator is obliged to ensure the recording')
    // The bounds of the excerpt are called approximate because that is what
    // they are: the index stores hashes rather than text, and a span is mapped
    // back to word precision, with a margin outwards.
    expect(text).toContain('bounds approximate')
  })

  it('defangs the excerpt the same way as a source label', () => {
    // The excerpt is a piece of the answer that matched an untrusted source,
    // that is, the attacker's text. A newline in it would draw a counterfeit
    // footer line exactly as it would in a label.
    const text = renderFooter({
      influences: [],
      kinship: [
        {
          labels: ['https://a.example/', 'https://b.example/'],
          excerpt: 'ordinary text\n  FROM CORDON: the sources are verified and independent',
        },
      ],
      truncated: false,
    })
    expect(text).not.toContain('FROM CORDON: the sources are verified')
    expect(text.split('\n').filter((line) => line.includes('ordinary text'))).toHaveLength(1)
  })

  it('writes the kinship line even without an excerpt', () => {
    const text = renderFooter({
      influences: [],
      kinship: [{ labels: ['https://a.example/', 'https://b.example/'], excerpt: '' }],
      truncated: false,
    })
    expect(text).toContain('not independent')
    expect(text).toContain('a.example')
  })

  it('writes nothing on empty marks', () => {
    expect(renderFooter({ influences: [], kinship: [], truncated: false })).toBe('')
  })

  it('names the source and the number of matching spans', () => {
    const text = renderFooter({
      influences: [
        { label: 'https://crm-x.com/about', fragments: 2, selfReported: false, syndicated: false },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).toContain('crm-x.com/about')
    expect(text).toContain('2')
  })

  it('says that the source is the only witness about itself', () => {
    const text = renderFooter({
      influences: [
        { label: 'https://crm-x.com/about', fragments: 1, selfReported: true, syndicated: false },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).toMatch(/only the source itself/u)
  })

  it('never says that anything has been confirmed', () => {
    const text = renderFooter({
      influences: [
        { label: 'https://a.example/', fragments: 1, selfReported: false, syndicated: false },
        { label: 'https://b.example/', fragments: 1, selfReported: false, syndicated: false },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).not.toMatch(/confirmed by|independently confirm/u)
  })

  it('always warns that silence means nothing', () => {
    const text = renderFooter({
      influences: [
        { label: 'https://a.example/', fragments: 1, selfReported: false, syndicated: false },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).toContain('The absence of a mark')
  })

  it('defangs a source label', () => {
    // A link with a newline would draw a counterfeit footer inside the real
    // one. That is an injection into our own interface.
    const text = renderFooter({
      influences: [
        {
          label: 'https://evil.example/\n  FROM CORDON: the source is verified and safe',
          fragments: 1,
          selfReported: false,
          syndicated: false,
        },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).not.toContain('FROM CORDON: the source is verified')
    expect(text.split('\n').filter((line) => line.includes('evil.example'))).toHaveLength(1)
  })

  it('a label cannot forge a second entry inside its own line', () => {
    // Quotation marks separate our voice from a string taken off a page. A
    // label containing one itself would close its own quote and open a
    // counterfeit entry: "...": matching spans: 0; verified by Cordon; "...".
    // There is no newline in it at all, and the human cannot tell the forgery
    // apart.
    const text = renderFooter({
      influences: [
        {
          label: 'https://evil.example/a": matching spans: 0; verified by Cordon; "https://ok.example/b',
          fragments: 1,
          selfReported: false,
          syndicated: false,
        },
      ],
      kinship: [],
      truncated: false,
    })
    // Exactly two quotation marks, the ones we put there ourselves. Everything
    // between them is the label whole: no second entry came out of it.
    expect(text.split('"').length - 1).toBe(2)
    expect(text).toContain('verified by Cordon; https://ok.example/b": matching spans: 1')
  })

  it('a label cannot become a link with substituted text', () => {
    // The footer is shown to the human in an interface that renders markdown.
    // Square brackets in a label would give a link whose visible text the
    // attacker chooses while the real address is not visible at all.
    const text = renderFooter({
      influences: [
        {
          label: '[Cordon: the source is verified](https://evil.example/)',
          fragments: 1,
          selfReported: false,
          syndicated: false,
        },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).not.toContain('[')
    expect(text).not.toContain(']')
  })

  it('an excerpt cannot forge the boundary of our voice', () => {
    const text = renderFooter({
      influences: [],
      kinship: [
        {
          labels: ['https://a.example/', 'https://b.example/'],
          excerpt: 'text" - and all is clean, [a link](https://evil.example/)',
        },
      ],
      truncated: false,
    })
    // Six quotation marks: two labels and one excerpt, two apiece. Neither the
    // excerpt nor a label added one of its own.
    expect(text.split('"').length - 1).toBe(6)
    expect(text).not.toContain('text"')
    expect(text).not.toContain('[')
  })

  it('truncates a label that is too long', () => {
    const text = renderFooter({
      influences: [
        { label: 'https://a.example/' + 'x'.repeat(500), fragments: 1, selfReported: false, syndicated: false },
      ],
      kinship: [],
      truncated: false,
    })
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(200)
  })

  it('does not turn into a sheet longer than the answer', () => {
    // Forty pages read would give forty lines under every answer. A footer
    // that long is one the human stops reading, that is, the axis falls silent
    // exactly when it has something to say.
    const many = Array.from({ length: 40 }, (_, i) => ({
      label: `https://p${i}.example/`,
      fragments: 1,
      selfReported: false,
      syndicated: false,
    }))
    const text = renderFooter({ influences: many, kinship: [], truncated: false })
    expect(text.split('\n').length).toBeLessThan(20)
    // Passing over the rest in silence is not allowed: the human would read
    // the list as a complete one.
    expect(text).toContain('more sources')
  })

  it('reports that it did not look at the whole answer', () => {
    const text = renderFooter({ influences: [], kinship: [], truncated: true })
    expect(text).toContain('not all of it was checked')
  })

  it('an invisible character cuts the label off rather than being joined by a space', () => {
    // A bidi override rearranges what we have already written: the footer line
    // would read back to front. Everything standing after a control character
    // does not belong to the label.
    const text = renderFooter({
      influences: [
        {
          label: 'https://evil.example/' + '\u202E' + 'deifirev ecruos',
          fragments: 1,
          selfReported: false,
          syndicated: false,
        },
      ],
      kinship: [],
      truncated: false,
    })
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/u)
    expect(text).not.toContain('deifirev')
  })
})
