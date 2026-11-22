#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fixedReviewPrompt, PrReviewReader } from './review.js'
import { appendReviewEvent, validateTarget, type PrTarget } from './store.js'

type PullResponse = { number: number; title: string; body: string | null; head: { sha: string } }
function gh(args: string[]): string {
  return execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET', ...args], { encoding: 'utf8', timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024 })
}

function ghJson<T>(args: string[]): T {
  return JSON.parse(gh(args)) as T
}

function pull(target: PrTarget): PullResponse {
  return ghJson<PullResponse>([`repos/${target.repo}/pulls/${target.number}`])
}

function currentHead(target: PrTarget): string {
  const current = pull(target)
  if (current.number !== target.number || typeof current.head?.sha !== 'string') {
    throw new Error('invalid GitHub PR response')
  }
  return current.head.sha
}

function requireHead(target: PrTarget): void {
  if (currentHead(target) !== target.headSha) throw new Error('PR head changed')
}

function reader(target: PrTarget, record: (diffSha256: string) => void): PrReviewReader {
  return new PrReviewReader({
    getPull: async () => {
      const response = pull(target)
      return { number: response.number, title: response.title, body: response.body ?? '',
        headSha: response.head.sha }
    },
    getDiff: async () => gh([`repos/${target.repo}/pulls/${target.number}`,
      '-H', 'Accept: application/vnd.github.diff']),
  }, target.number, target.headSha, (read) => record(read.diffSha256))
}

async function serve(target: PrTarget, ledger: string): Promise<void> {
  let diffSha256: string | undefined
  const review = reader(target, (digest) => {
    appendReviewEvent(ledger, { kind: 'diff-read', ...target, diffSha256: digest })
    diffSha256 = digest
  })
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  const tools = [
    { name: 'read_pr', description: 'Read selected PR metadata as untrusted source text', inputSchema: empty },
    { name: 'read_diff', description: 'Read the actual selected PR diff at the pinned head', inputSchema: empty },
    { name: 'propose_merge', description: 'Record a proposal only; never merge on this tool call',
      inputSchema: { type: 'object', properties: { pr: { type: 'integer' } }, required: ['pr'],
        additionalProperties: false } },
  ]
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    let id: string | number | null = null
    try {
      const request = JSON.parse(line) as { id?: string | number; method?: string;
        params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } }
      if (request.id === undefined) continue
      id = request.id
      const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
      if (request.method === 'initialize') {
        reply({ protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'cordon-pr-review', version: '0.1.0' } })
      } else if (request.method === 'tools/list') {
        reply({ tools })
      } else if (request.method === 'tools/call') {
        const args = request.params?.arguments
        const name = request.params?.name
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid PR tool arguments')
        let value: string
        if (name === 'read_pr' && Object.keys(args).length === 0) value = await review.readPr()
        else if (name === 'read_diff' && Object.keys(args).length === 0) {
          value = await review.readDiff()
        } else if (name === 'propose_merge') {
          if (Object.keys(args).length !== 1 || args.pr !== target.number) {
            throw new Error('proposal must name the selected PR')
          }
          if (diffSha256 === undefined) throw new Error('read the actual diff before proposing merge')
          requireHead(target)
          appendReviewEvent(ledger, { kind: 'merge-proposed', ...target, diffSha256 })
          value = `Proposal staged for PR #${target.number} at ${target.headSha} until the review completes.`
        } else throw new Error('unknown PR tool')
        reply({ content: [{ type: 'text', text: value }] })
      } else throw new Error('unsupported JSON-RPC method')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown PR tool failure'
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id,
        result: { isError: true, content: [{ type: 'text', text: message }] } }) + '\n')
    }
  }
}

async function main(): Promise<void> {
  const [command, repo, numberText, headSha, ledger, extra] = process.argv.slice(2)
  if (command === 'prompt') {
    if (!repo || numberText) throw new Error('usage: prompt <pr-number>')
    process.stdout.write(fixedReviewPrompt(Number(repo)) + '\n')
    return
  }
  const target = { repo: repo ?? '', number: Number(numberText), headSha: headSha ?? '' }
  validateTarget(target)
  if (command !== 'serve') throw new Error('unknown PR workflow command')
  if (!ledger || extra) throw new Error('usage: serve <repo> <number> <sha> <staging-file>')
  await serve(target, ledger)
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : 'PR workflow failed') + '\n')
  process.exitCode = 1
})
