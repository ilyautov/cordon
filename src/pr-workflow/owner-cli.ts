#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readTrustedCi, type CiIdentity } from './ci.js'
import { getPinnedDiff, getPullSnapshot } from './github.js'
import { openMergeApp } from './merge-github-app.js'
import { verifyMergeHead } from './merge-head.js'
import { captureMergePolicy } from './merge-policy.js'
import { assessMerge, assessReview, executeMerge } from './merge.js'
import { approvalForReceipt, approveReceipt, consumeReceiptApproval, sameCiIdentity } from './owner-approvals.js'
import { publishReviewComment } from './owner-comment.js'
import { readReviewReceipt, sameMergePolicy, sameSnapshot, type PrTarget, type ReviewReceipt } from './store.js'

export { fixedComment } from './owner-comment.js'

function positiveInteger(value: string | undefined, field: string): number {
  const number = Number(value)
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(number)) {
    throw new Error('invalid ' + field)
  }
  return number
}

const github = { getPullSnapshot, getPinnedDiff, readTrustedCi, publishReviewComment }
const mergeProtection = { captureMergePolicy, verifyMergeHead, openMergeApp }

type OwnerEvidence = {
  allow: true
  approvalsDir: string
  readCi: () => CiIdentity
  facts: { receipt: ReviewReceipt; current: PrTarget; diffSha256: string; ci: CiIdentity }
}

function readOwnerEvidence(args: string[], env: NodeJS.ProcessEnv, access: typeof github):
  OwnerEvidence | { allow: false; reason: string } {
  const [command, path, approvalsDir, run, attempt] = args
  if (!['check', 'approve', 'comment', 'merge'].some((name) => name === command) ||
    args.length !== 5 || !path || !approvalsDir) {
    throw new Error('usage: owner-cli <check|approve|comment|merge> <review-receipt> <owner-dir> <ci-run-id> <ci-run-attempt>')
  }
  const receipt = readReviewReceipt(path)
  if (command === 'merge' && receipt.mergePolicy === undefined) {
    throw new Error('merge requires branch protection pinned during review')
  }
  const runId = positiveInteger(run, 'CI run ID')
  const config = {
    workflowId: positiveInteger(env['CORDON_PR_TRUSTED_WORKFLOW_ID'], 'trusted workflow ID'),
    workflowSha: env['CORDON_PR_TRUSTED_WORKFLOW_SHA'] ?? '',
    workflowRef: env['CORDON_PR_TRUSTED_WORKFLOW_REF'] ?? '',
    runAttempt: positiveInteger(attempt, 'CI run attempt'),
  }
  const current = access.getPullSnapshot(receipt.repo, receipt.number)
  if (!sameSnapshot(receipt, current)) return { allow: false, reason: 'snapshot-changed' }
  if (command !== 'comment' && !receipt.mergeProposed) return { allow: false, reason: 'not-proposed' }
  const diffSha256 = createHash('sha256').update(access.getPinnedDiff(receipt)).digest('hex')
  if (receipt.diffSha256 !== diffSha256) return { allow: false, reason: 'diff-changed' }
  const readCi = () => access.readTrustedCi(receipt, runId, config)
  const ci = readCi()
  if (!sameSnapshot(receipt, access.getPullSnapshot(receipt.repo, receipt.number))) {
    return { allow: false, reason: 'snapshot-changed' }
  }
  return { allow: true, approvalsDir, readCi, facts: { receipt, current, diffSha256, ci } }
}

function verifyPinnedProtection(receipt: ReviewReceipt, protection: typeof mergeProtection) {
  const expected = receipt.mergePolicy
  if (expected === undefined) throw new Error('merge requires branch protection pinned during review')
  protection.verifyMergeHead(receipt, expected.profile)
  if (!sameMergePolicy(expected, protection.captureMergePolicy(receipt, expected.profile))) {
    throw new Error('GitHub branch protection changed since review')
  }
  return expected
}

export function runOwnerCommand(args: string[], env = process.env, access = github, protection = mergeProtection) {
  const [command] = args
  if (command === 'merge') throw new Error('owner actions are disabled in this draft')
  const evidence = readOwnerEvidence(args, env, access)
  if (!evidence.allow) return evidence
  const { approvalsDir, facts } = evidence
  const { receipt, ci } = facts
  if (command === 'comment') {
    const { commentId, published } = access.publishReviewComment(approvalsDir, receipt)
    return { allow: true, reason: published ? 'comment-published' : 'comment-already-present', commentId }
  }
  if (receipt.mergePolicy !== undefined) verifyPinnedProtection(receipt, protection)
  if (command === 'approve') {
    const review = assessReview(facts)
    if (!review.allow) return review
    const approval = approveReceipt(approvalsDir, receipt, ci)
    return { allow: true, reason: 'approval-issued', ci, approval }
  }
  const approval = approvalForReceipt(approvalsDir, receipt, ci)
  return { ...assessMerge({ ...facts, approval }), ci, approval }
}

export async function runGuardedMergeCommand(
  args: string[], env = process.env, access = github, protection = mergeProtection,
) {
  const keyFile = env['CORDON_PR_MERGE_APP_KEY_FILE']
  if (args[0] !== 'merge' || !keyFile) throw new Error('owner actions are disabled in this draft')
  const evidence = readOwnerEvidence(args, env, access)
  if (!evidence.allow) return evidence
  const { approvalsDir, facts } = evidence
  const { receipt, ci } = facts
  const approval = approvalForReceipt(approvalsDir, receipt, ci)
  const decision = assessMerge({ ...facts, approval })
  if (!decision.allow) return decision
  const policy = verifyPinnedProtection(receipt, protection)
  const { repo, number, headSha, baseRef, baseSha } = receipt
  const writer = await protection.openMergeApp({ repo, number, headSha, baseRef, baseSha },
    policy.repositoryId, policy.profile.mergeAppId, keyFile)

  const mergeSha = await executeMerge({ ...facts, approval }, {
    currentSnapshot: async () => {
      if (!sameCiIdentity(ci, evidence.readCi())) throw new Error('trusted CI changed before merge')
      verifyPinnedProtection(receipt, protection)
      return access.getPullSnapshot(repo, number)
    },
    consumeApproval: async (record) => consumeReceiptApproval(approvalsDir, receipt, ci, record),
    merge: (expected) => writer.merge(expected),
  })
  return { allow: true, reason: 'merged', mergeSha }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2)
    const decision = args[0] === 'merge' ? await runGuardedMergeCommand(args) : runOwnerCommand(args)
    process.stdout.write(JSON.stringify(decision) + '\n')
    process.exitCode = decision.allow ? 0 : 1
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'owner command refused') + '\n')
    process.exitCode = 1
  }
}
