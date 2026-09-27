import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Cordon } from '../src/cordon.js'
import { DEFAULT_POLICY, type Policy } from '../src/policy/defaults.js'

/**
 * `./sales.csv` and `sales.csv` are one file. Found building the landing
 * page's demo: the user named `./sales.csv`, the call read `./sales.csv`,
 * and after the file was read the call was still asked about, because the
 * leading `./` was compared as a segment the user never said.
 */

function summarize(task: string, file: string) {
  const policy: Policy = structuredClone(DEFAULT_POLICY)
  policy.mode = 'interactive'
  policy.profile = { effects: ['read', 'summarize'], resources: { paths: [], hosts: [] } }
  policy.tools = { summarize_sales: ['summarize'] }
  policy.arguments = { summarize_sales: { file: 'resource', summary: 'content' } }
  policy.notify = { file: null }
  const cordon = new Cordon({ policy, cordonHome: mkdtempSync(join(tmpdir(), 'cordon-home-')), sessionId: 's' })
  cordon.onUserPrompt(task)
  cordon.observe('month,orders\n2026-08,120\nreturns included', { id: 't', kind: 'file', label: file, trust: 'untrusted' })
  return cordon.gate({ tool: 'summarize_sales', args: { file, summary: 'August: 120 orders' } })
}

describe('a relative path the user named', () => {
  it('is named with or without the leading ./', () => {
    expect(summarize('Read ./sales.csv and summarize August.', './sales.csv').kind).toBe('allow')
    expect(summarize('Read sales.csv and summarize August.', './sales.csv').kind).toBe('allow')
    expect(summarize('Read ./data/sales.csv and summarize August.', './data/sales.csv').kind).toBe('allow')
  })

  it('a file the user did not name is still asked about', () => {
    expect(summarize('Read ./sales.csv and summarize August.', './customers.csv').kind).toBe('ask')
    expect(summarize('Read ./sales.csv and summarize August.', '../secrets/sales.csv').kind).toBe('ask')
  })
})
