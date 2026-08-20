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
  // The report is also the verdict on the run itself. On CI the process is
  // allowed to be killed after it has finished, because vitest 4's forks pool
  // has been seen to hang once every test has passed, so nothing upstream of
  // here can be trusted to say whether the suite was green. A missing file
  // throws, which is the right answer: no report means no run.
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

for (const file of ['README.md', 'README.ru.md']) {
  const text = readFileSync(file, 'utf8')
  for (const claim of claims) {
    // The two READMEs word the claim in different languages, so the number is
    // looked for on its own rather than inside a phrase.
    if (!new RegExp(`(?<![0-9])${claim.value}(?![0-9])`, 'u').test(text)) {
      wrong.push(`${file}: ${claim.value} ${claim.what} is not stated anywhere in the file`)
    }
  }
}

if (wrong.length === 0) {
  console.log(`the numbers in the READMEs are the real ones: ${claims.map((c) => `${c.value} ${c.what}`).join(', ')}`)
  process.exit(0)
}

console.error('a number in the documentation no longer matches the repository:')
for (const line of wrong) console.error(`  ${line}`)
console.error('')
console.error('update the text rather than the check: a stale number reads as a fresh one')
process.exit(1)
