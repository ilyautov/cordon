import { describe, expect, it } from 'vitest'
import { assignments } from '../../src/provenance/assignments.js'

describe('values the user assigned to a controlled field', () => {
  it('reads the field, one connector and the value', () => {
    expect(assignments('Set the Rent amount to 1200.', ['amount'])).toEqual([['amount', '1200']])
    expect(assignments('amount=1200', ['amount'])).toEqual([['amount', '1200']])
    expect(assignments('Amount: 1200, thanks', ['amount'])).toEqual([['amount', '1200']])
    expect(assignments('the amount is 1200!', ['amount'])).toEqual([['amount', '1200']])
  })

  it('takes nothing from a value next to the field with no connector', () => {
    // Kimi review: "the amount 99000 you paid was disputed" assigned 99000.
    // Adjacency alone is not an assignment; a connector is.
    expect(assignments('amount 1200', ['amount'])).toEqual([])
    expect(assignments('the amount 99000 you paid was disputed', ['amount'])).toEqual([])
  })

  it('drops thousands separators and keeps the decimals as written', () => {
    expect(assignments('amount to 1,200.50', ['amount'])).toEqual([['amount', '1200.50']])
    expect(assignments('amount to 1200.00', ['amount'])).toEqual([['amount', '1200.00']])
  })

  it('takes nothing from a number written in any other format', () => {
    // Codex review: 1.200,50 must not become 1.200, 50 or 120050, and a form
    // the rule cannot read must not be kept either, or a string argument
    // spelled the same way would match it. A value the rule cannot read is a
    // value the user did not state.
    for (const text of ['amount to 1.200,50', 'amount to 1e3', 'amount to 1e+21', 'amount to 12a']) {
      expect(assignments(text, ['amount']), text).toEqual([])
    }
  })

  it('takes nothing from a number cut short or split by a space', () => {
    // Codex review: a long run of dots was cut at the token limit and the
    // rest dropped, leaving 1; a narrow no-break space split 1 200 into 1.
    expect(assignments(`amount to 1${'.'.repeat(63)}9`, ['amount'])).toEqual([])
    expect(assignments('amount to 1\u202F200', ['amount'])).toEqual([])
    expect(assignments('amount to 1 200', ['amount'])).toEqual([])
  })

  it('does not fold a digit the user did not write into one they did', () => {
    // Codex and Kimi review: NFKC turned an enclosed one into 1 and a
    // superscript two into 2.
    expect(assignments('amount: \u246000', ['amount'])).toEqual([])
    expect(assignments('area: 5\u00B2', ['area'])).toEqual([])
    expect(assignments('status to "\uFF21pproved"', ['status'])).toEqual([['status', '\uFF21pproved']])
  })

  it('takes nothing from a field named inside another quoted value', () => {
    // Codex and Kimi review: the user quoted a memo, and the memo's words
    // assigned an amount.
    expect(assignments(`memo to "amount to '99000'"`, ['memo', 'amount'])).toEqual([['memo', "amount to '99000'"]])
    expect(assignments("set memo to 'amount is 500 '", ['memo', 'amount'])).toEqual([['memo', 'amount is 500']])
  })

  it('reads a quote that opens a word, not an apostrophe inside one', () => {
    expect(assignments("don't wait: set the amount to 5, it's due", ['amount'])).toEqual([['amount', '5']])
  })

  it('takes nothing from a number that is not assigned to the field', () => {
    // Codex review: "don't pay 99000" and "pay 50 of the 1200" state no
    // amount; a number anywhere in the message is not an assignment.
    expect(assignments("don't pay 99000", ['amount'])).toEqual([])
    expect(assignments('pay 50 of the 1200 we owe', ['amount'])).toEqual([])
    expect(assignments('the amount is not 99000', ['amount'])).toEqual([])
  })

  it('reads a quoted value whole', () => {
    expect(assignments("new_start_time to '2024-05-20 10:00'", ['new_start_time'])).toEqual([
      ['new_start_time', '2024-05-20 10:00'],
    ])
    expect(assignments('status: "Approved"', ['status'])).toEqual([['status', 'Approved']])
  })

  it('knows a field written with spaces for its underscores', () => {
    expect(assignments('new start time to 10:00', ['new_start_time'])).toEqual([['new_start_time', '10:00']])
  })

  it('finds the field only as a whole word', () => {
    expect(assignments('the prepaymentamount to 5', ['amount'])).toEqual([])
    expect(assignments('amounts to 5', ['amount'])).toEqual([])
  })

  it('keeps every value assigned to the field', () => {
    expect(assignments('amount to 10, and later amount to 20', ['amount'])).toEqual([
      ['amount', '10'],
      ['amount', '20'],
    ])
  })
})
