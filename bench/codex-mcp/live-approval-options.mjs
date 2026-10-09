export const approvalRunOptions = (args) => {
  const humanReview = args.includes('--human-review')
  const timeoutProbe = args.includes('--timeout-probe')
  if (humanReview && timeoutProbe) throw new Error('human review and timeout probe are separate arms')
  const hold = humanReview || args.includes('--hold') || timeoutProbe
  return {
    humanReview, timeoutProbe, hold,
    gatewayWaitMs: humanReview ? 300_000 : timeoutProbe ? 5_000 : hold ? 30_000 : 0,
    toolTimeoutSec: humanReview ? 330 : timeoutProbe ? 1 : hold ? 45 : null,
    processTimeoutMs: humanReview ? 420_000 : 180_000,
  }
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`

export const humanReviewShowCommand = ({ home, bundle, id, node }) =>
  `CORDON_HOME=${shellQuote(home)} ${shellQuote(node)} ${shellQuote(bundle)} approve ${shellQuote(id)} --show`
