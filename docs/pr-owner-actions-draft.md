# Draft GitHub owner actions

The local PR workflow produces one finalized review receipt. It identifies the repository, PR, head SHA, review run, and diff digest, and records whether the agent proposed merging. A proposal is advisory. An owner still reviews the diff and decides what to publish or merge.

The draft owner CLI can inspect a receipt on disk after building the library.

```bash
node dist/pr-workflow/owner-cli.js check /path/to/review-receipt.json
```

`check` prints the receipt and an `owner-actions-draft` denial, then exits nonzero. Missing or invalid receipts are refused. `approve`, `comment`, and `merge` are disabled. The CLI has no GitHub transport or credential access. The fixed comment template only uses the PR number and reviewed head SHA. The draft approval store and merge evaluator are exercised only by local tests.

## Requirements for enabling owner actions

- **Finalized review evidence.** Accept a receipt from the owner-controlled review runner after it verifies delivery of the diff, the hooks for that run, and successful completion. Bind the approval to the exact receipt and authoritative quality result. A recorded proposal cannot authorize a merge by itself.
- **Reviewed base.** Include the target repo, base ref and SHA in the review and approval. Fetch the diff from immutable revisions and revalidate the head and base before attempting the merge. GitHub's expected-head SHA protects only the head. Require server-side enforcement of the intended base and required checks with a merge identity that cannot bypass those rules.
- **Authenticated CI evidence.** Verify a trusted publisher and a result that states the candidate repo, PR, head and base actually checked by the pinned workflow definition and run attempt. A commit status's link and generic bot creator identify a claimed reference. The draft evaluator can recognize the old reference, but still denies the merge.
- **Owner approval lifecycle.** Retain exact binding and one-time consumption. Implement atomic expiry and reissue, including how to handle a command whose outcome is unclear. Keep owner approvals and write credentials outside the agent's authority.
- **GitHub publication.** Bind API host and repository identity to the approved target, and verify server confirmation before reporting a merge. Any optional fixed comment should require the finalized receipt and name its reviewed SHA.

[GitHub commit statuses](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status)
and [GitHub pull request merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
describe the API fields used by the draft.
