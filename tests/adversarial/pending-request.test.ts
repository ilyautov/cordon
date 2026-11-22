import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCompletePendingRequest } from '../../bench/codex-mcp/pending-request.mjs'

describe('benchmark pending approval reader', () => {
  it('waits for the gateway to finish writing a newly visible request file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cordon-pending-test-'))
    const path = join(root, 'request.json')
    writeFileSync(path, '')
    const timer = setTimeout(() => writeFileSync(path,
      JSON.stringify({ tool: 'send_email', args: '{"to":"ops@acme.example"}' })), 20)
    try {
      expect(await readCompletePendingRequest(path, 1000)).toEqual({
        tool: 'send_email', args: '{"to":"ops@acme.example"}',
      })
      expect(JSON.parse(readFileSync(path, 'utf8')).tool).toBe('send_email')
    } finally {
      clearTimeout(timer)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
