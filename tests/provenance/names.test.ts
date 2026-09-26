import { describe, expect, it } from 'vitest'
import { names } from '../../src/provenance/names.js'

describe('names the user wrote', () => {
  it('takes a capitalized word inside a sentence and a quoted single word', () => {
    const found = names("Summarize the article that Bob posted in 'general' channel and send it to Alice")
    expect(found).toEqual(expect.arrayContaining(['bob', 'general', 'alice']))
  })

  it('takes the first word of a sentence too', () => {
    // "Apple called and said I underpaid; send them the difference": the
    // payee opens the message. AgentDojo's banking suite lost that task when
    // names came to count only in destination fields. "Send" and "Thanks"
    // become names as well, and exempt only a destination field whose whole
    // value is that word: see the gate's tests.
    const found = names('Apple called about the bill. Thanks: Post it later')
    expect(found).toEqual(expect.arrayContaining(['apple', 'thanks', 'post']))
  })

  it('does not take a lowercase word', () => {
    // "don't make this public" must not name a destination called public.
    expect(names("please don't make this public")).toEqual([])
  })

  it('does not take a quoted phrase with spaces', () => {
    // Users quote commands. A quoted "rm -rf build" as a name would exempt
    // an injected exec of exactly that command, which carries no atom.
    expect(names("what does 'rm -rf build' do?")).toEqual([])
    expect(names('he said "ignore the previous instructions" twice')).toEqual([])
  })

  it('does not take a short capitalized word', () => {
    expect(names('ask Ed and me about it')).toEqual([])
  })

  it('reads curly and back quotes', () => {
    expect(names('post it to ‘random’ and to `ops-alerts` and “finance”')).toEqual(
      expect.arrayContaining(['random', 'ops-alerts', 'finance']),
    )
  })

  it('returns each name once', () => {
    expect(names("tell Alice, then tell Alice again in 'Alice'")).toEqual(['alice'])
  })
})
