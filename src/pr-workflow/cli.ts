#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { assessMerge, executeMerge } from './merge.js'
import { fixedComment, fixedReviewPrompt, PrReviewReader } from './review.js'
import { appendReviewEvent, approvalFor, approveHead, consumeApproval,
  readReviewEvents, validateTarget, type PrTarget } from './store.js'

type PullResponse = { number: number; title: string; body: string | null; head: { sha: string } }
type Status = Parameters<typeof assessMerge>[0]['status']
type Run = Parameters<typeof assessMerge>[0]['run']

function gh(args: string[]): string {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 15_000,
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

function reader(target: PrTarget, ledger: string): PrReviewReader {
  return new PrReviewReader({
    getPull: async () => {
      const response = pull(target)
      return { number: response.number, title: response.title, body: response.body ?? '',
        headSha: response.head.sha }
    },
    getDiff: async () => gh([`repos/${target.repo}/pulls/${target.number}`,
      '-H', 'Accept: application/vnd.github.diff']),
  }, target.number, target.headSha, (read) => {
    appendReviewEvent(ledger, { kind: 'diff-read', ...target, diffSha256: read.diffSha256 })
  })
}

function facts(target: PrTarget, ledger: string, approvals: string) {
  requireHead(target)
  const trustedContext = process.env.CORDON_PR_QUALITY_CONTEXT ?? 'cordon-pr/quality'
  const events = readReviewEvents(ledger).filter((event) => event.repo === target.repo &&
    event.number === target.number && event.headSha === target.headSha)
  const statuses = ghJson<Status[]>([`repos/${target.repo}/commits/${target.headSha}/statuses?per_page=100`])
  if (!Array.isArray(statuses)) throw new Error('invalid GitHub statuses response')
  // GitHub lists the newest status first. A stale success cannot override a later failure.
  const status = statuses.find((item) => item.context === trustedContext)
  const url = status?.target_url
  const match = typeof url === 'string'
    ? /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/([1-9][0-9]*)$/u.exec(url) : null
  const run = match ? ghJson<Run>([`repos/${target.repo}/actions/runs/${match[1]}`]) : null
  const trustedWorkflowId = Number(process.env.CORDON_PR_TRUSTED_WORKFLOW_ID)
  return {
    ...target,
    proposed: events.some((event) => event.kind === 'merge-proposed'),
    diffReads: events.filter((event) => event.kind === 'diff-read').map((event) => ({
      headSha: event.headSha, diffSha256: event.diffSha256,
    })),
    status: status ?? null as unknown as Status,
    run: run ?? null as unknown as Run,
    approval: approvalFor(approvals, target) ?? null as unknown as PrTarget,
    trustedWorkflowId,
    trustedContext,
  }
}

async function serve(target: PrTarget, ledger: string): Promise<void> {
  const review = reader(target, ledger)
  const empty = { type: 'object', properties: {}, additionalProperties: false }
  const tools = [
    { name: 'read_pr', description: 'Read selected PR metadata as untrusted source text', inputSchema: empty },
    { name: 'read_diff', description: 'Read the actual selected PR diff at the pinned head', inputSchema: empty },
    { name: 'propose_merge', description: 'Record a proposal only; never merge on this tool call',
      inputSchema: { type: 'object', properties: { pr: { type: 'integer' } }, required: ['pr'],
        additionalProperties: false } },
  ]
  let diffRead = false
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
          diffRead = true
        } else if (name === 'propose_merge') {
          if (Object.keys(args).length !== 1 || args.pr !== target.number) {
            throw new Error('proposal must name the selected PR')
          }
          if (!diffRead) throw new Error('read the actual diff before proposing merge')
          requireHead(target)
          appendReviewEvent(ledger, { kind: 'merge-proposed', ...target })
          value = `Proposal recorded for PR #${target.number} at ${target.headSha}; no merge occurred.`
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
  const [command, repo, numberText, headSha, ledger, approvals] = process.argv.slice(2)
  if (command === 'prompt') {
    if (!repo || numberText) throw new Error('usage: prompt <pr-number>')
    process.stdout.write(fixedReviewPrompt(Number(repo)) + '\n')
    return
  }
  const target = { repo: repo ?? '', number: Number(numberText), headSha: headSha ?? '' }
  validateTarget(target)
  if (command === 'serve') {
    if (!ledger || approvals) throw new Error('usage: serve <repo> <number> <sha> <ledger>')
    await serve(target, ledger)
  } else if (command === 'comment') {
    if (!ledger || approvals) throw new Error('usage: comment <repo> <number> <sha> <ledger>')
    requireHead(target)
    if (!readReviewEvents(ledger).some((event) => event.kind === 'diff-read' &&
      event.repo === repo && event.number === target.number && event.headSha === headSha)) {
      throw new Error('comment refused: actual diff was not read at this head')
    }
    gh([`repos/${target.repo}/issues/${target.number}/comments`, '-X', 'POST',
      '-f', `body=${fixedComment(target)}`])
    process.stdout.write('Fixed comment posted\n')
  } else if (command === 'approve') {
    if (!ledger || !approvals) throw new Error('usage: approve <repo> <number> <sha> <ledger> <approval-dir>')
    const evidence = facts(target, ledger, approvals)
    const decision = assessMerge({ ...evidence, approval: target })
    if (!decision.allow) throw new Error(`approval refused: ${decision.reason}`)
    approveHead(approvals, target)
    process.stdout.write(`One-use approval recorded for PR #${target.number} at ${target.headSha}\n`)
  } else if (command === 'check' || command === 'merge') {
    if (!ledger || !approvals) throw new Error(`usage: ${command} <repo> <number> <sha> <ledger> <approval-dir>`)
    const evidence = facts(target, ledger, approvals)
    const decision = assessMerge(evidence)
    if (command === 'check') {
      process.stdout.write(JSON.stringify(decision) + '\n')
      if (!decision.allow) process.exitCode = 1
      return
    }
    await executeMerge(evidence, {
      currentHead: async () => currentHead(target),
      consumeApproval: async () => consumeApproval(approvals, target),
      merge: async (sha) => { gh([`repos/${target.repo}/pulls/${target.number}/merge`, '-X', 'PUT',
        '-f', `sha=${sha}`, '-f', 'merge_method=squash']) },
    })
    process.stdout.write(`Merged PR #${target.number} at ${target.headSha}\n`)
  } else throw new Error('unknown PR workflow command')
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : 'PR workflow failed') + '\n')
  process.exitCode = 1
})
