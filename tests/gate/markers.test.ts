import { describe, expect, it } from 'vitest'
import { foldCommand, mentions } from '../../src/gate/gate.js'

// The shell check compares markers against a command folded once, by the
// rules of the platform the harness runs on. Four review rounds patched the
// comparison one spelling at a time; these cases pin the model instead.
const names = (command: string, marker: string, windows: boolean) =>
  mentions(foldCommand(command.toLowerCase(), windows), foldCommand(marker, windows))

describe('self-protection markers on Windows', () => {
  it('backslashes, doubled separators and `.` segments are one path', () => {
    for (const command of [
      'copy evil.js C:\\Users\\u\\.claude\\hooks\\hook.js',
      'type C:\\Users\\u\\.claude\\\\settings.json',
      'type C:\\Users\\u\\.claude\\.\\hooks\\x.js',
    ]) expect(names(command, '.claude/hooks', true) || names(command, '.claude/settings', true), command).toBe(true)
  })

  it('trailing dots and spaces are dropped from a segment, as Windows drops them', () => {
    // Codex and Kimi, round fourteen.
    for (const command of [
      'copy evil.js C:\\Users\\u\\.claude.\\hooks\\x.js',
      'type C:\\Users\\u\\.claude..\\settings.json',
      'copy evil.js "C:\\Users\\u\\.claude \\hooks\\x.js"',
    ]) expect(names(command, '.claude/hooks', true) || names(command, '.claude/settings', true), command).toBe(true)
  })
})

describe('self-protection markers on POSIX', () => {
  it('a backslash is an escape, not a separator', () => {
    // Codex and Kimi, round fourteen: folding it refused a sed idiom and a
    // JSON payload that only carry the text.
    expect(names("sed -i 's/\\.claude\\/hooks/x/' notes.md", '.claude/hooks', false)).toBe(false)
    expect(names('curl -d \'{"p":"C:\\\\Users\\\\u\\\\.claude\\\\hooks"}\' localhost:3000', '.claude/hooks', false)).toBe(false)
  })

  it('doubled separators and `.` segments are still one path', () => {
    expect(names('cat ~/.claude//settings.json', '.claude/settings', false)).toBe(true)
    expect(names('cat ~/.claude/./././settings.json', '.claude/settings', false)).toBe(true)
  })

  it('a trailing dot names another directory there', () => {
    expect(names('cat ~/.claude./hooks/x', '.claude/hooks', false)).toBe(false)
  })
})

describe('folding cost', () => {
  it('a ten-megabyte command folds in well under the hook timeout', () => {
    // Codex, round fourteen: folding once per marker took 5.4 s here.
    const command = 'x/./'.repeat(2_500_000)
    const started = Date.now()
    foldCommand(command, true)
    foldCommand('.'.repeat(10_000_000) + '\\', true)
    // Two folds against a 5 s hook timeout, with room for a loaded machine:
    // a full parallel run pushed them past 1.5 s.
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
