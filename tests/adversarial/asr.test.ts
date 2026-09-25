import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BATTERY } from './battery.js'
import { renderReport } from './report.js'
import { runBattery, type Row } from './runner.js'

/**
 * The battery's entry point. It MEASURES: an attack the design never claimed
 * to stop is a table row, not a failure. What it does judge is the promise
 * each spec writes down — an attack expected to be stopped on a profile and
 * getting through there is a regression, and a regression fails the suite.
 * Review found the earlier shape of this file, green whatever the rate did,
 * could let a closed attack reopen with CI still green.
 */

function printTable(rows: Row[]): void {
  const attacks = rows.filter((row) => !row.control)
  console.log('\nattack | profile | outcome | mechanism | success')
  for (const row of rows) {
    console.log(
      `${row.id} | ${row.profile} | ${row.outcome} | ${row.mechanism} | ${row.success}` +
        (row.gateIfSeen ? ` | gate if seen: ${row.gateIfSeen}` : '') +
        (row.detail ? ` | ${row.detail}` : ''),
    )
  }
  for (const profile of [...new Set(rows.map((row) => row.profile))]) {
    const slice = attacks.filter((row) => row.profile === profile)
    const success = slice.filter((row) => row.success).length
    console.log(`ASR ${profile}: ${success}/${slice.length}`)
  }
  const mismatches = attacks.filter((row) => !row.matchesExpectation)
  if (mismatches.length > 0) {
    console.log('\nexpectation mismatches:')
    for (const row of mismatches) console.log(`${row.id} | ${row.profile} | ${row.outcome}`)
  }
}

describe('the adversarial battery measures, and holds what it promised', () => {
  it(
    'no attack the spec expects stopped gets through',
    { timeout: 300_000 },
    () => {
      const reopened = runBattery(BATTERY)
        .filter((row) => !row.control && row.success && !row.matchesExpectation)
        .map((row) => `${row.id} on ${row.profile}: ${row.outcome}`)
      expect(reopened).toEqual([])
    },
  )

  it(
    'measures the attack success rate and writes the report',
    { timeout: 300_000 },
    () => {
      const rows = runBattery(BATTERY)
      printTable(rows)
      writeFileSync(join(process.cwd(), 'docs', 'adversarial-report.md'), renderReport(rows, BATTERY))
      expect(rows.length).toBeGreaterThan(0)
    },
  )

  it(
    'is reproducible: two consecutive runs give the identical table',
    { timeout: 300_000 },
    () => {
      expect(runBattery(BATTERY)).toEqual(runBattery(BATTERY))
    },
  )
})
