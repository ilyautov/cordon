import { describe, it, expect } from 'vitest'
import { detectMixedScript } from '../../src/sanitize/mixed-script.js'

// A Latin e (U+0065) inside a Cyrillic word. The data in this file stays in
// Cyrillic and Greek deliberately: the module looks for exactly the pairs of
// scripts whose letters are visual twins, and there is no such pair to write
// it with in Latin alone.
const SPOOFED = 'Сб\u0065рбанк'

describe('detectMixedScript', () => {
  it('finds Latin inside a Cyrillic word', () => {
    const findings = detectMixedScript(`a transfer to ${SPOOFED}`)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('mixed-script')
    expect(findings[0]?.detail).toBe('Latin+Cyrillic')
  })

  it('does not fire on neighbouring words of different scripts', () => {
    expect(detectMixedScript('an order at Wildberries today: заказ')).toEqual([])
  })

  it('does not fire on digits and signs inside a word', () => {
    expect(detectMixedScript('item 12345, price 1 dollar, артикул 12345')).toEqual([])
  })

  it('ignores words shorter than three letters', () => {
    expect(detectMixedScript('о\u0065')).toEqual([])
  })

  it('reports every unique word once', () => {
    expect(detectMixedScript(`${SPOOFED} and again ${SPOOFED}`)).toHaveLength(1)
  })
})

describe('detectMixedScript: Greek', () => {
  it('finds a Greek omicron inside a Latin word', () => {
    // A Greek omicron (U+03BF) in place of the Latin o.
    const findings = detectMixedScript('sign in through Gοogle')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toBe('Latin+Greek')
  })

  it('finds a Greek Alpha inside a Cyrillic word', () => {
    // A Greek capital Alpha (U+0391) in place of the Cyrillic А.
    expect(detectMixedScript('счёт в Αльфа банке')[0]?.detail).toBe('Cyrillic+Greek')
  })

  it('does not treat Greek symbol letters from technical writing as a sign', () => {
    // Delta, mu, Omega, pi are symbols for quantities: they have no twins in
    // Latin or Cyrillic.
    expect(detectMixedScript('ΔTmax no higher than 2 K, capacity 10 μFarad')).toEqual([])
    expect(detectMixedScript('the Ωmeter showed πrad of deviation')).toEqual([])
  })
})

/**
 * The half of the task that matters more: the module must stay silent on
 * ordinary text. A false finding here costs more than a missed substitution:
 * it teaches people to switch the check off entirely.
 */
describe('detectMixedScript: harmless text', () => {
  const BENIGN: ReadonlyArray<[string, string]> = [
    ['brand names inside Russian text', 'Купил iPhone 15 Pro в М.Видео за 89 990 рублей, доставка СДЭК.'],
    ['code', 'Функция getUserById возвращает null, если записи нет в PostgreSQL.'],
    ['units of measurement', 'Скорость 100 Мбит/с, задержка 20 ms, объём 2 ТБ, ток 5 мА.'],
    ['a URL and an e-mail address', 'Смотри https://example.com/каталог?q=телефон и пиши на info@пример.рф'],
    ['emoji', 'Отчёт готов ✅ проверь пожалуйста 🙏 созвон в 10:00 👨\u200D💻'],
    ['mathematics', 'Площадь S = πr², радиус r; ΔT = 5 °C, σ = 3 мкм, задержка μs.'],
    ['Ukrainian', 'Ласкаво просимо! Ціна — 250 грн, їхній ґудзик, вулиця Хрещатик.'],
    ['Kazakh', 'Қазақстан Республикасы, Нұр-Сұлтан қаласы, әуежай, ғылым, һәм.'],
    ['Japanese with Latin', '本日のMTGは15:00からZoomで行います。よろしくお願いします。'],
    ['company details', 'Договор №123 от 01.09.2025, ООО «Ромашка», ИНН 7701234567, оплата SWIFT.'],
    ['European diacritics', 'Кафе «Crème brûlée» на Straße, партнёр Ünal, город Łódź.'],
    ['Greek text', 'Ελληνικά κείμενο για δοκιμή, τηλέφωνο 210 1234567.'],
  ]

  for (const [name, text] of BENIGN) {
    it(`stays silent: ${name}`, () => {
      expect(detectMixedScript(text)).toEqual([])
    })
  }
})

describe('detectMixedScript: mathematical Latin', () => {
  it('mathematical Latin counts as Latin', () => {
    // U+1D412 is a mathematical bold S: to Unicode it is Script=Common, to a
    // human an ordinary Latin S.
    const findings = detectMixedScript('\u{1D412}бербанк')
    expect(findings.some((f) => f.kind === 'mixed-script')).toBe(true)
    expect(findings[0]?.detail).toBe('Latin+Cyrillic')
  })

  it('mathematical Latin on its own produces no finding', () => {
    expect(detectMixedScript('the formula \u{1D400}\u{1D401}\u{1D402} holds')).toEqual([])
  })

  it('the characters of the block are neither removed nor substituted', () => {
    // The module has no removal surface: it returns findings only, and the
    // sample reports the word verbatim, together with the original character.
    expect(detectMixedScript('a matrix \u{1D400} of size n')).toEqual([])
    expect(detectMixedScript('\u{1D412}бербанк')[0]?.sample).toBe('\u{1D412}бербанк')
  })
})

describe('detectMixedScript: mathematical Greek', () => {
  it('mathematical Greek letters count as neither Latin nor Greek', () => {
    // A quantity symbol set in bold: one script, no finding.
    expect(detectMixedScript('the overheat \u{1D6AB}Tmax is within range')).toEqual([])
  })

  it('mathematical Latin is still a sign of Latin', () => {
    const findings = detectMixedScript('\u{1D412}бербанк confirms it')
    expect(findings.some((f) => f.kind === 'mixed-script')).toBe(true)
  })

  it('mathematical Greek does not make a Cyrillic word mixed', () => {
    // \u{1D6AB} is a bold Delta, a quantity symbol rather than a twin of a
    // Cyrillic letter. This test is what tells the old behaviour from the new
    // one: before the fix the whole block counted as Latin and the word was
    // declared mixed.
    expect(detectMixedScript('the increment \u{1D6AB}ельта is counted')).toEqual([])
  })

  it('an escape sequence does not glue itself to the next word', () => {
    // In sources and documentation a `\\n` before a word is an everyday sight.
    // The backslash does not count as a letter, so the `n` used to stick to the
    // Cyrillic and produce a finding on honest text. A false positive on
    // legitimate text costs more than a miss here: this is an axis of risk, not
    // of removal, and its job is not to get in the way of reading normal
    // documents.
    // The Cyrillic words below read "read the files" and "line", "tab".
    expect(detectMixedScript("scope read\\nпочитай файлы")).toEqual([])
    expect(detectMixedScript("строка\\tтабуляция")).toEqual([])
  })

  it('but it still sees a substitution behind an escape sequence', () => {
    // Exactly one leading letter is dropped. A word where the substitution
    // survives is found as before.
    const found = detectMixedScript("\\nСбербank")
    expect(found).toHaveLength(1)
    expect(found[0]?.detail).toBe('Latin+Cyrillic')
  })
})
