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

## GitHub publication and merge

`comment` and `merge` return a refusal in this draft. Enabling writes requires a separate owner credential, a finalized review for publication, and merge controls that enforce the reviewed base and head at mutation time. GitHub's expected-SHA REST parameter checks the head. The merge adapter contract requires atomic enforcement of the full snapshot. [GitHub pull request merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
