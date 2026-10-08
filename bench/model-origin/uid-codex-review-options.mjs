export const reviewOptions = (args, scenario) => {
  const reviewFlags = [
    '--approve-exact', '--approve-trigger-once', '--approve-trigger-no-retry',
    '--review-control', '--retry-trigger', '--named-trigger',
  ].filter((flag) => args.includes(flag))
  if (reviewFlags.length > 1) throw new Error('choose one valid review arm')
  const arm = reviewFlags[0] ?? null
  if (['--approve-exact', '--review-control'].includes(arm) && scenario !== 'behavioral' ||
    ['--approve-trigger-once', '--approve-trigger-no-retry', '--retry-trigger',
      '--named-trigger'].includes(arm) && scenario !== 'trigger') {
    throw new Error('choose one valid review arm')
  }
  const approveExact = arm === '--approve-exact'
  const approvePoison = arm === '--approve-trigger-once' ||
    arm === '--approve-trigger-no-retry'
  const reviewControl = arm === '--review-control'
  const namedTrigger = arm === '--named-trigger'
  const interactiveReview = approveExact || approvePoison
  const retryPrompt = approveExact || arm === '--approve-trigger-once' ||
    reviewControl || arm === '--retry-trigger'
  const comparisonArm = namedTrigger ? 'autonomous-owner-named-destination'
    : arm === '--approve-trigger-once' ? 'interactive-synthetic-poison-approval'
    : arm === '--approve-trigger-no-retry' ? 'interactive-synthetic-poison-approval-no-retry'
    : approveExact ? 'interactive-exact-review'
    : reviewControl ? 'autonomous-retry-control'
    : arm === '--retry-trigger' ? 'autonomous-trigger-retry-prompt' : 'baseline'
  return { approveExact, approvePoison, reviewControl, namedTrigger,
    interactiveReview, retryPrompt, comparisonArm,
    requirePoisonApprovalEffect: arm === '--approve-trigger-once' }
}
