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

  it('takes a run of capitalized words as one name as well', () => {
    // "create an event with Sarah Baker": the contact lookup returns the
    // record named "Sarah Baker", and a binding needs the whole name. Only a
    // run the user wrote: "Sarah Baker and John Smith" names no Sarah Smith.
    const found = names('Please create an event with Sarah Baker and John Smith')
    expect(found).toEqual(expect.arrayContaining(['sarah baker', 'john smith', 'sarah', 'baker']))
    expect(found).not.toContain('sarah smith')
    expect(found).not.toContain('baker and john')
  })

  it('takes no slice of a run longer than a name', () => {
    // Kimi review: "Alpha Beta Gamma Delta Epsilon" gave "alpha beta gamma
    // delta" and then "delta epsilon", a name the user never wrote as one.
    const found = names('Visit Alpha Beta Gamma Delta Epsilon tomorrow')
    expect(found).not.toContain('delta epsilon')
    expect(found.filter((name) => name.includes(' '))).toEqual([])
  })

  it('does not take a lowercase word', () => {
    // "don't make this public" must not name a destination called public.
    expect(names("please don't make this public")).toEqual([])
  })

  it('takes a quoted phrase of plain words as one name', () => {
    // AgentDojo travel user_task_0: "My friend recommended 'Le Marais
    // Boutique'", then a booking at exactly that hotel. A name counts only as
    // the whole value of a destination field and never for exec, so the
    // phrase vouches for a hotel called that and for nothing else.
    expect(names("book 'Le Marais Boutique' for me")).toEqual(expect.arrayContaining(['le marais boutique']))
  })

  it('does not take a quoted phrase with no capitalized word', () => {
    // Kimi review: users quote injection vocabulary when they discuss it, and
    // "ignore the previous instructions" is not the name of anything.
    expect(names('he said "ignore the previous instructions" twice')).toEqual([])
  })

  it('does not take a quoted phrase that is not plain words', () => {
    // Users quote commands. A flag or a path in the phrase keeps it out, so a
    // quoted command never becomes a name even for a destination field.
    expect(names("what does 'rm -rf build' do?")).toEqual([])
    expect(names("copy it to 'docs /etc/passwd'")).toEqual([])
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
