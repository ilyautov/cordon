# Local GitHub PR review

This opt-in workflow runs Codex locally against pinned PR head and base commits. It saves a local receipt of a completed review and any merge proposal. The GitHub client in this workflow makes read-only requests to github.com.

| Surface | Content |
| --- | --- |
| Human prompt | A fixed review instruction and the PR number |
| `read_pr` | GitHub title and body, treated as untrusted source text |
| `read_diff` | Immutable GitHub comparison of the pinned base and head, with the selected PR checked before and after the read |
| `propose_merge` | A proposal for the selected PR, staged until the review completes |
| Review receipt | Repository, PR number, head SHA, base branch and SHA, run ID, diff SHA-256 and whether Codex proposed a merge |

The runner uses an empty working directory, read-only Codex sandbox and an explicit tool allowlist. Cordon's hooks cover the prompt and each PR tool call. The runner passes a limited environment to Codex. The read-only GitHub client uses the local `gh auth` session under the same OS account. Run under a separate identity with read-only credentials if that account also has owner permissions.

## Run a local review

Use `gh` and `git`. Build the library and hook bundle, then pin the current head. The runner verifies the PR head ref and resolves the base branch tip directly. Give the runner a new filename in a private directory.

```bash
npm ci
npm run build
repo=OWNER/REPO
pr=12
sha=$(gh api --hostname github.com "repos/$repo/pulls/$pr" --jq .head.sha)
review_dir=$(mktemp -d /tmp/cordon-pr-review.XXXXXX)
node scripts/pr-review-local.mjs "$repo" "$pr" "$sha" "$review_dir/receipt.json"
```

The JSON event stream contains the local review output. The receipt is written once, after a successful Codex exit, a completed turn, and a final answer. The runner requires paired tool hooks from that session and matching SHA-256 digests in the fetched diff, the post-tool hook, and the Codex tool result. A failed or interrupted run leaves no receipt. Use a new filename for each review.

The receipt identifies the diff observed at the tool boundary and whether the model proposed a merge. Inspect the review output and the diff yourself. The comparison is limited to complete text diffs below GitHub's file limit and the reader's size limit. Check the current head and base before relying on the receipt. The tool result identifies the diff at the tool boundary. Model context and reasoning depend on the host.

For a review that can authorize a guarded merge, set `CORDON_PR_MERGE_PROFILE_FILE` in the trusted runner environment. The runner records the exact repository protection in the receipt and withholds it if protection changes during the review. See [guarded merge setup](pr-owner-actions-draft.md#guarded-merge).
