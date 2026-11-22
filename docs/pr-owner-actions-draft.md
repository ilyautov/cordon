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

## Guarded merge

The `merge` command requires a new review that pins the repository ID, the target branch, the two App identities, and the protection in effect. Save a profile in the trusted owner's directory and give the review runner its path through `CORDON_PR_MERGE_PROFILE_FILE`. For example, to require the GitHub Actions App as the status publisher and a dedicated merge App with ID `123456`:

```json
{
  "baseRef": "main",
  "statusAppId": 15368,
  "statusAppSlug": "github-actions",
  "statusContext": "cordon/exact-snapshot",
  "mergeAppId": 123456
}
```

The publisher and merge App must have distinct App IDs. Configure the Apps and active rulesets before reviewing.

- Require a pull request, allow the `merge` method, and require the exact status context from the configured status App with strict up-to-date checks. The publisher posts a commit status on the reviewed PR head. Use a trusted publisher and trusted workflow code.
- Protect the exact target branch against deletion and non-fast-forward updates without any bypass. Restrict all other branches against updates by the merge App. The ruleset for other branches can allow a bypass for the repository owner, identified by GitHub User ID.
- Use a GitHub user credential with repository administration access for the protection reads. Supply it via `GH_TOKEN` in the runner environment and keep it outside the review process and local credentials it can access. Install the dedicated merge App on the selected repository. It needs Contents write and Pull requests read. Keep its RSA private key readable only by the local owner, in a directory outside the review agent's authority. The command requests a short-lived installation token restricted to this repository and the required permissions.

The PR head must be one commit whose only parent is the reviewed base SHA. The successful required status must be on that exact head and come from the configured App. The runner compares the protection before and after the review. The owner commands `approve` and `check` require the same protection and exact head status when the receipt carries a merge profile. Inspect the completed review and CI evidence and use the same approval directory and run identifiers:

```bash
export CORDON_PR_MERGE_APP_KEY_FILE=/path/to/owner-only/merge-app.pem
node dist/pr-workflow/owner-cli.js merge /path/to/receipt.json "$owner_dir" "$run_id" "$attempt"
```

Without that key path, the command refuses the merge. It verifies the PR snapshot, diff, CI, one-use approval, required status and pinned rules, then checks the CI identity, current snapshot, status and rules again after obtaining App credentials. A detected change stops the command before spending the approval. A change to the reviewed snapshot or its protections requires a fresh review and approval.

The merge request carries GitHub's expected head SHA. The App's server-side rules enforce the destination and require a current base with the status on the reviewed one-commit head. The command spends the approval immediately before its single request and verifies the resulting commit's parents on success. If GitHub's outcome cannot be confirmed, check the PR state before doing anything further. The command never repeats that request.

GitHub's merge API accepts the expected head SHA. It has no expected ruleset revision parameter. A rule change after the final read can affect the rules GitHub enforces for the in-flight request. Keep ruleset administration separate from the merge App. [GitHub pull request merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
