#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readTrustedCi } from './ci.js'
import { getPinnedDiff, getPullSnapshot } from './github.js'
import { assessMerge, assessReview } from './merge.js'
import { approvalForReceipt, approveReceipt } from './owner-approvals.js'
import { readReviewReceipt, sameSnapshot, type ReviewReceipt } from './store.js'

export function fixedComment({ number, headSha }: Pick<ReviewReceipt, 'number' | 'headSha'>): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid PR number')
  if (!/^[a-f0-9]{40}$/u.test(headSha)) throw new Error('invalid PR head SHA')
  return `Automated review was recorded for PR #${number} at ${headSha}. ` +
    'This comment contains no agent output; the owner must inspect the review and the diff.'
}

function positiveInteger(value: string | undefined, field: string): number {
  const number = Number(value)
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(number)) {
    throw new Error('invalid ' + field)
  }
  return number
}

const github = { getPullSnapshot, getPinnedDiff, readTrustedCi }

export function runOwnerCommand(args: string[], env = process.env, access = github) {
  const [command, path, approvalsDir, run, attempt] = args
  if (command === 'comment' || command === 'merge') {
    throw new Error('owner actions are disabled in this draft')
  }
  if ((command !== 'check' && command !== 'approve') || args.length !== 5 || !path || !approvalsDir) {
    throw new Error('usage: owner-cli <check|approve> <review-receipt> <approval-dir> <ci-run-id> <ci-run-attempt>')
  }
  const receipt = readReviewReceipt(path)
  const runId = positiveInteger(run, 'CI run ID')
  const config = {
    workflowId: positiveInteger(env['CORDON_PR_TRUSTED_WORKFLOW_ID'], 'trusted workflow ID'),
    workflowSha: env['CORDON_PR_TRUSTED_WORKFLOW_SHA'] ?? '',
    workflowRef: env['CORDON_PR_TRUSTED_WORKFLOW_REF'] ?? '',
    runAttempt: positiveInteger(attempt, 'CI run attempt'),
  }
  const current = access.getPullSnapshot(receipt.repo, receipt.number)
  if (!sameSnapshot(receipt, current)) return { allow: false, reason: 'snapshot-changed' }
  if (!receipt.mergeProposed) return { allow: false, reason: 'not-proposed' }
  const diffSha256 = createHash('sha256').update(access.getPinnedDiff(receipt)).digest('hex')
  if (receipt.diffSha256 !== diffSha256) return { allow: false, reason: 'diff-changed' }
  const ci = access.readTrustedCi(receipt, runId, config)
  if (!sameSnapshot(receipt, access.getPullSnapshot(receipt.repo, receipt.number))) {
    return { allow: false, reason: 'snapshot-changed' }
  }
  const facts = { receipt, current, diffSha256, ci }
  if (command === 'approve') {
    const review = assessReview(facts)
    if (!review.allow) return review
    const approval = approveReceipt(approvalsDir, receipt, ci)
    return { allow: true, reason: 'approval-issued', ci, approval }
  }
  const approval = approvalForReceipt(approvalsDir, receipt, ci)
  return { ...assessMerge({ ...facts, approval }), ci, approval }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const decision = runOwnerCommand(process.argv.slice(2))
    process.stdout.write(JSON.stringify(decision) + '\n')
    process.exitCode = decision.allow ? 0 : 1
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'owner command refused') + '\n')
    process.exitCode = 1
  }
}
