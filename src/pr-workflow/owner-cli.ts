#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readReviewReceipt, type ReviewReceipt } from './store.js'

export function fixedComment({ number, headSha }: Pick<ReviewReceipt, 'number' | 'headSha'>): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid PR number')
  if (!/^[a-f0-9]{40}$/u.test(headSha)) throw new Error('invalid PR head SHA')
  return `Automated review was recorded for PR #${number} at ${headSha}. ` +
    'This comment contains no agent output; the owner must inspect the review and the diff.'
}

export function runOwnerCommand(args: string[]): {
  allow: false
  reason: 'owner-actions-draft'
  receipt: ReviewReceipt
} {
  const [command, path] = args
  if (command === 'approve' || command === 'comment' || command === 'merge') {
    throw new Error('owner actions are disabled in this draft')
  }
  if (command !== 'check' || !path || args.length !== 2) {
    throw new Error('usage: owner-cli check <review-receipt>')
  }
  return { allow: false, reason: 'owner-actions-draft', receipt: readReviewReceipt(path) }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const decision = runOwnerCommand(process.argv.slice(2))
    process.stdout.write(JSON.stringify(decision) + '\n')
    process.exitCode = 1
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'owner command refused') + '\n')
    process.exitCode = 1
  }
}
