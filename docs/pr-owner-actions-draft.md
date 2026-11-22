# Draft GitHub owner actions

The local reviewer records the repository, PR, head SHA, base branch and SHA, review run, and SHA-256 of the exact diff. Generate a fresh receipt if an earlier reviewer recorded only the head. A merge proposal is advisory. Inspect the review output and diff before issuing an approval.

## Verify and approve a candidate

Use a trusted owner session with `gh`, `git`, and `unzip`. Build the library with `npm run build`. Pick an Actions run of a workflow at an independently trusted commit. A run of the candidate's own workflow cannot substitute for the trusted check.

```bash
export CORDON_PR_TRUSTED_WORKFLOW_ID=123
export CORDON_PR_TRUSTED_WORKFLOW_SHA=FULL_TRUSTED_COMMIT_SHA
export CORDON_PR_TRUSTED_WORKFLOW_REF=main
owner_dir=$(mktemp -d /tmp/cordon-owner.XXXXXX)
run_id=456
attempt=1
node dist/pr-workflow/owner-cli.js approve /path/to/receipt.json "$owner_dir" "$run_id" "$attempt"
node dist/pr-workflow/owner-cli.js check /path/to/receipt.json "$owner_dir" "$run_id" "$attempt"
```

Both commands use GitHub read requests to verify the current PR and immutable text diff. They verify the workflow ID, trusted source commit and branch, successful latest attempt, and the artifact digest against GitHub's metadata. The evidence record must name the same PR, head, base branch and SHA, and diff digest. `approve` issues a local one-use approval for that exact review and CI attempt. `check` reports whether the approved candidate still matches. Its decision applies at the time of the check.

An approval expires after one hour. The owner can run `approve` again after expiration or consumption if the same evidence still validates. Renewal creates a new generation. Old generations and their spent or expired markers stay in the owner-controlled directory. Keep that directory outside the agent's authority.

## Trusted lab workflow

The lab example in `bench/pr-workflow/lab/quality-attestation.yml` dispatches a read-only check from a trusted branch. Install it as `.github/workflows/quality-gate.yml` in a disposable lab. Place `quality-attestation.mjs`, `quality-check.mjs`, and the built `github.js` and `store.js` in `.github/scripts/cordon-pr41/` with a `package.json` declaring `"type": "module"`. Dispatch it with the receipt's `pr_number`, `head_sha`, `base_ref`, `base_sha`, and `diff_sha256` as inputs. The example reads the lab's `login.html` as data. Adapt the quality policy to your repository independently of any candidate.

## Publish a review snapshot

From the owner session, use a GitHub user credential with permission to comment on the PR. Use the same owner-controlled directory for all attempts.

```bash
node dist/pr-workflow/owner-cli.js comment /path/to/receipt.json "$owner_dir" "$run_id" "$attempt"
```

`comment` verifies the current PR and immutable diff against the completed review and trusted CI artifact. The comment records that reviewed snapshot with its head SHA, base branch and SHA, and SHA-256 of the diff. It contains only the fixed template and those fields. Branch names use URL-style escaping. The text stays accurate as a historical record when the PR changes. A later snapshot needs its own evidence.

A repeat returns the existing matching comment ID for the authenticated user. The owner directory records the publication attempt before sending it. If GitHub's response is lost, the next attempt looks for the existing comment. While the previous result is unconfirmed, it reports an error and withholds another POST. This state is separate from merge approvals.

## Merge

`merge` returns a refusal in this draft. Enabling it requires a separate owner credential and merge controls that enforce the reviewed base and head at mutation time. GitHub's expected-SHA REST parameter checks the head. The merge adapter contract requires atomic enforcement of the full snapshot. [GitHub pull request merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
