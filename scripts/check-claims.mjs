#!/usr/bin/env node
// Checks that the numbers the READMEs state out loud are the real ones.
//
// The project's own rule is a number instead of an adjective, and a number
// that has quietly gone stale is worse than the adjective it replaced: the
// reader has no way to tell which of the claims on the page are still true.
// Three numbers are cheap to verify, so they are verified rather than trusted.
//
// Usage: node scripts/check-claims.mjs [vitest-report.json]
// Without the report the script runs the suite itself; CI passes the report
// from the run it already did.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function testCount(reportPath) {
  let path = reportPath
  if (!path) {
    path = join(mkdtempSync(join(tmpdir(), 'cordon-claims-')), 'vitest.json')
    execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${path}`], {
      stdio: 'ignore',
    })
  }
  // The report is also the verdict on the run itself. A run killed at its
  // time limit exits non-zero with nothing to say about what happened before
  // the kill, so the count and the pass come from the file the run wrote. A
  // missing file throws, which is the right answer: no report means no run.
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (!report.success) {
    throw new Error(`the suite did not pass: ${report.numFailedTests} of ${report.numTotalTests} failed`)
  }
  return report.numTotalTests
}

/** The attack corpus is a module, so it is counted by its entries, not its lines. */
function attackCount() {
  const source = readFileSync('tests/fixtures/attacks.ts', 'utf8')
  const body = source.slice(source.indexOf('ATTACKS: AttackCase[] = ['))
  return body.slice(0, body.indexOf('\n]')).split('\n').filter((line) => /^\s{2}\{/u.test(line)).length
}

/** Directories inside the loyalty corpus hold variants of a document, not documents. */
function loyaltyCount() {
  return readdirSync('tests/fixtures/loyalty').filter((name) =>
    statSync(join('tests/fixtures/loyalty', name)).isFile(),
  ).length
}

const claims = [
  { what: 'tests', value: testCount(process.argv[2]) },
  { what: 'pinned attack vectors', value: attackCount() },
  { what: 'legitimate documents', value: loyaltyCount() },
]

const wrong = []

// The social preview states the test count too, and it is the one place where
// a stale number is invisible to whoever changed the code: it is a picture,
// generated from the SVG beside it. The number is checked in the source rather
// than in the PNG, so regenerating the image is the fix.
const pages = [
  { file: 'README.md', states: claims },
  { file: 'README.ru.md', states: claims },
  { file: 'assets/social-preview.svg', states: claims.filter((c) => c.what === 'tests') },
]

for (const page of pages) {
  const text = readFileSync(page.file, 'utf8')
  for (const claim of page.states) {
    // The pages word the claim in different languages, so the number is looked
    // for on its own rather than inside a phrase.
    if (!new RegExp(`(?<![0-9])${claim.value}(?![0-9])`, 'u').test(text)) {
      wrong.push(`${page.file}: ${claim.value} ${claim.what} is not stated anywhere in the file`)
    }
  }
}

// The version badge is the same failure mode: a number on the page that no
// longer matches the repository, and one that goes stale at every release.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const badge = readFileSync('README.md', 'utf8').match(/badge\/version-([0-9.]+)-/u)
if (!badge) {
  wrong.push('README.md: the version badge is gone')
} else if (badge[1] !== version) {
  wrong.push(`README.md: the version badge says ${badge[1]}, package.json says ${version}`)
}

if (wrong.length === 0) {
  console.log(`the numbers on the pages are the real ones: ${claims.map((c) => `${c.value} ${c.what}`).join(', ')}, version ${version}`)
  process.exit(0)
}

console.error('a number in the documentation no longer matches the repository:')
for (const line of wrong) console.error(`  ${line}`)
console.error('')
console.error('update the text rather than the check: a stale number reads as a fresh one')
process.exit(1)
