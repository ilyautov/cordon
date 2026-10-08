// A reviewer may approve the owner check as well as the source edit.
export function consumedReviewsExact(journal, reviews, runs) {
  const consumed = journal.filter((event) => event.decision === 'approved' && event.tool === 'run')
  return consumed.every((event) => {
    const id = typeof event.reason === 'string'
      ? event.reason.match(/^the owner approved this call once \(([0-9a-f]{16})\):/u)?.[1]
      : undefined
    return id !== undefined && reviews.some((review) => review.id === id && review.approved &&
      runs.some((run) => run.command === review.command))
  })
}
