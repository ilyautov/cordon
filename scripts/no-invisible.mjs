#!/usr/bin/env node
// Forbids literal invisible characters in the sources, the tests and the prose.
//
// The rule has existed since the start of the project and has been broken six
// times, including a literal NUL in the file where the kinship of sources is
// computed: the tests were green and a scan is what found it. A character
// invisible in review is invisible to the person doing the review too, so the
// rule has to be a check rather than an agreement.
//
// An escape sequence is allowed and is the only way to write such a character:
// the reader sees text in its place and understands what stands there.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['src', 'tests', 'scripts', 'docs', '.github']

/**
 * Prose is checked as well as code, and for a sharper reason than tidiness: a
 * reader copies a policy example out of the README into their own file. An
 * invisible character riding along in that snippet is the very attack this
 * project exists to stop, delivered by the project's own documentation.
 */
const EXTENSIONS = /\.(?:ts|mjs|js|md|txt|ya?ml)$/u

/**
 * The invisible and control characters that have no business being literals in
 * a source file.
 *
 * The newline and the tab are excluded for obvious reasons. NBSP is included:
 * it looks like an ordinary space, behaves differently, and appears in code
 * only by a slip of the keyboard. The character class itself is written with
 * escape sequences for the same reason the whole file exists.
 */
const FORBIDDEN =
  /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFFF9-\uFFFB\u00A0\u00AD\u061C\u180E\u3164\uFEFF]|[\u{E0000}-\u{E007F}]/u

function* files(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (EXTENSIONS.test(path)) yield path
  }
}

const found = []

/** The markdown at the repository root, without descending into node_modules. */
function* rootFiles() {
  for (const entry of readdirSync('.')) {
    if (EXTENSIONS.test(entry) && statSync(entry).isFile()) yield entry
  }
}

for (const source of [...ROOTS.map((root) => files(root)), rootFiles()]) {
  for (const path of source) {
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = FORBIDDEN.exec(line)
        if (!match) return
        const code = match[0].codePointAt(0) ?? 0
        found.push({
          where: `${relative(process.cwd(), path)}:${index + 1}`,
          column: match.index + 1,
          code: 'U+' + code.toString(16).toUpperCase().padStart(4, '0'),
        })
      })
  }
}

if (found.length === 0) {
  console.log('no literal invisible characters in the sources')
  process.exit(0)
}

console.error('literal invisible characters in the sources:')
for (const hit of found) {
  console.error(`  ${hit.where}, column ${hit.column}: ${hit.code}`)
}
console.error('')
console.error('write them as an escape sequence instead of the character itself:')
console.error('a character invisible in review is invisible to the reviewer too')
process.exit(1)
