# Local GitHub PR review

This opt-in workflow runs Codex locally against a pinned PR head. It saves a local receipt of a completed review and any merge proposal. The GitHub client in this workflow makes read-only requests to github.com.

| Surface | Content |
| --- | --- |
| Human prompt | A fixed review instruction and the PR number |
| `read_pr` | GitHub title and body, treated as untrusted source text |
| `read_diff` | GitHub diff, with the PR head checked before and after the read |
| `propose_merge` | A proposal for the selected PR, staged until the review completes |
| Review receipt | Repository, PR number, head SHA, run ID, diff SHA-256 and whether Codex proposed a merge |

The runner uses an empty working directory, read-only Codex sandbox and an explicit tool allowlist. Cordon's hooks cover the prompt and each PR tool call. The runner passes a limited environment to Codex. The read-only GitHub client uses the local `gh auth` session under the same OS account. Run under a separate identity with read-only credentials if that account also has owner permissions.

## Run a local review

Build the library and hook bundle, then pin the current head. Give the runner a new filename in a private directory.

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

The receipt identifies the diff observed at the tool boundary and whether the model proposed a merge. Inspect the review output and the diff yourself. The receipt does not establish how much of a large diff fit into the model's context, whether the model understood it, or whether the PR's base branch has changed.
