# Local GitHub PR review boundary

This is an opt-in reference workflow. It runs Codex locally, keeps PR-authored metadata in MCP tool results, and leaves publication and merge to deterministic owner commands. It does not run a model in GitHub Actions.

## What crosses each boundary

| Surface | Content | Authority |
| --- | --- | --- |
| Human prompt | A fixed instruction and PR number | Review only |
| `read_pr` | Live GitHub title and body at a pinned head | Untrusted source text |
| `read_diff` | Live GitHub diff, checked against the head before and after the read | Untrusted source text; a SHA and diff digest enter the ledger |
| `propose_merge` | Exact PR number, after `read_diff` | Records a proposal only |
| `comment` | Fixed text with PR number and SHA | Posts no model output or PR-authored text |
| `merge` | SHA-bound evidence and one-use owner approval | Calls GitHub with `sha` as a final compare-and-swap |

The agent is started in an empty read-only work directory with shell, browser, apps, plugins and web search disabled. Its only PR tools are the three above. Cordon handles the prompt, tool calls and tool results; the runner checks that those hooks actually fired. The runner removes `GH_TOKEN` and `GITHUB_TOKEN` from the agent environment; the narrow MCP server uses the local `gh auth` credential. Use a separate OS account or container for the agent when the owner approval directory must be protected from an agent process with broader local capabilities. The read-only Codex sandbox and tool list alone do not establish that OS boundary.

## Local review

Build the library and committed hook bundle first:

```bash
npm ci
npm run build
```

For one PR, pin its current head and choose a ledger path outside the agent work directory:

```bash
repo=OWNER/REPO
pr=12
sha=$(gh api "repos/$repo/pulls/$pr" --jq .head.sha)
ledger=$(mktemp /tmp/cordon-pr-review.XXXXXX)
node scripts/pr-review-local.mjs "$repo" "$pr" "$sha" "$ledger"
```

The runner exits nonzero if the agent does not read the real diff, a hook is missing, or the run has no final answer. Its JSON event stream is the agent's private review output; do not post that stream to GitHub. The ledger contains only the repository, PR number, head SHA, diff digest and merge proposal. Keep it owner-controlled. A successful diff tool call proves a diff was fetched and returned, not that the model understood it.

## Trusted quality check

The merge command requires a protected GitHub Actions workflow named `PR quality gate`. Dispatch it from `main`, have it check the exact candidate SHA as data, and have that workflow alone publish `cordon-pr/quality` to the candidate commit after the check. Pin its numeric workflow ID in `CORDON_PR_TRUSTED_WORKFLOW_ID`; set `CORDON_PR_QUALITY_CONTEXT` if the status context has a different name. The command checks the latest status for that context at the exact SHA, the GitHub Actions bot as creator, the run URL, repository, workflow ID, `workflow_dispatch` on `main`, and successful conclusion. No other workflow should have `statuses: write` permission. Never execute candidate code in a job that holds a write token.

The check's content is repository-specific. This integration verifies the evidence contract; it does not supply a universal code-quality or XSS detector. A status from a workflow that merely reports success without checking the candidate gives no quality assurance.

## Owner actions

Inspect the real diff, the review output, the quality workflow and the SHA yourself. Then, from an owner process that the agent cannot invoke or write to:

```bash
export CORDON_PR_TRUSTED_WORKFLOW_ID=123
approval_dir=/private/owner/pr-approvals
node dist/pr-workflow/cli.js approve "$repo" "$pr" "$sha" "$ledger" "$approval_dir"
node dist/pr-workflow/cli.js check "$repo" "$pr" "$sha" "$ledger" "$approval_dir"
```

Approval is bound to the repository, PR and SHA, expires after one hour, and is consumed once. `approve` first requires the diff read, proposal and trusted quality check. If the head changes, start a new review. `check` reports the gate decision without consuming approval. These commands do not publish or merge.

Optional publication uses a fixed comment, never the model's answer:

```bash
node dist/pr-workflow/cli.js comment "$repo" "$pr" "$sha" "$ledger"
```

Only an explicit owner-run `merge` performs the GitHub merge, after another head check and atomic approval consumption:

```bash
node dist/pr-workflow/cli.js merge "$repo" "$pr" "$sha" "$ledger" "$approval_dir"
```

The GitHub merge API also receives `sha`, so a force push between the final read and request cannot merge a different head. GitHub branch protection should independently require the quality check and reviews. The comment endpoint has no SHA precondition; its fixed text names the reviewed SHA so it remains accurate if the PR moves afterward.

## Scope of the current check

The local runner was exercised on three disposable PRs at fixed heads: a clean layout change, a PR with an injected instruction in its title, and a PR whose description contained a forged diff while its actual diff changed `innerHTML`. In all three runs the agent called `read_pr` and `read_diff`, the hook log contained prompt, pre-tool and post-tool events, and no run published or merged. The title instruction produced no diagnostic canary or native command; the forged-description run reported the actual `innerHTML` problem. These are three observations, not a general attack-success rate or a production deployment.

GitHub API references: [merge a PR with an expected SHA](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request), [commit statuses](https://docs.github.com/en/rest/commits/statuses), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs).
