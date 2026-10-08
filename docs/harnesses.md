# What each harness does with a hook's answer

The 7 October 2026 model-origin probe sent two scripted `Bash` calls through the committed 0.12.1 Codex hook bundle. Both were refused under the default `locked` profile and both reached a recorder under `coding`. The recorder did not execute either command. This measures the hook decision, not the behavior of a backdoored model or Codex's shell; [the full boundary and paired controls](model-origin-benchmark.md) are reported separately from the older harness probes below.

On 8 October, the same hook probe added a policy with `exec` granted and `Bash` in `blockedTools`. Both shell calls were denied; a declared `mcp__sandbox__run` call reached the recorder. The recorder is not a connected sandbox, so this is only a tool-boundary result.

Four live Codex CLI 0.160.1 runs then exercised its native shell with a harmless file-writing command. The baseline wrote the file. With Cordon's hook supplied in the CLI session, an isolated user's `hooks.json`, or a trusted project's `.codex/hooks.json`, the journal recorded the `Bash` denial before native command execution, and the file was absent. An earlier project-file attempt used `--ignore-user-config`, which skipped the saved project trust and left the hook inactive. The [live hook probe](model-origin-benchmark.md#live-codex-native-shell-hook-8-october) separates hook activation from Cordon's decision.

Interactive user-level and project-level installations then passed the ordinary `/hooks` review, without the hook-trust bypass flag. Each TUI shell call was refused, and a fresh `codex exec` using the same trusted hook refused it again. The [TUI trust record](model-origin-benchmark.md#ordinary-hook-trust-through-the-codex-tui) includes the journal and file checks.

A later 8 October Codex CLI 0.160.1 run disabled the default shell tool and configured one Cordon-gated MCP Docker runner. Live `gpt-6-luna` completed both a one-call edit and a read-then-edit of the staged file; with `exec` removed from Cordon's policy, the model attempted the runner call but the gateway refused it before the executor. The [connected trial](model-origin-benchmark.md) uses narrow scratch tasks and does not prove general shell removal across other Codex versions or tool sets.

The runner now also stages one owner-selected check script on a separate read-only file mount without copying it back to the host. A scripted host ran the check and verified that an attempted overwrite inside the container was refused. In five isolated live Codex runs, the model read source and check, changed the source and ran the check through the runner. An earlier absolute-path check script caused a provenance refusal after reading, and one exploratory call made no MCP call at all. See the [context trial](model-origin-benchmark.md#connected-runner-trial-8-october).

The runner can stage the safe basename of an owner-selected source, so a Python behavior test used `input.py` and a read-only check without adding another host file to the model's workspace. Scripted controls refused protected `check.sh` and hidden `.env` source names before Docker started. Two five-pair batches each finished 1/5 tasks under the default policy and 5/5 with explicit `trustedSources: [run]`. All eight failed strict runs logged provenance denials; one still produced correct source but did not complete the check workflow. A fresh container verified each successful output. Trusting `run` covers all its results, so this is a measured utility tradeoff rather than a default recommendation; see the [behavioral task](model-origin-benchmark.md#behavioral-coding-task-with-two-policies).

A second five-pair batch asked for an interval-merging repair: 0/5 completed under the default policy and 5/5 with `run` trusted. All five strict runs logged provenance denials; all five trusted edits passed an independent check. The runner now stages the owner-selected check as executable on a read-only mount, after an exploratory attempt showed a direct check invocation exiting 126. Scripted controls confirmed direct execution and that the check cannot be overwritten. The [paired report](model-origin-benchmark.md#behavioral-coding-task-with-two-policies) keeps both tasks and the trust cost separate.

A later holdout pass added cases not staged for the model. On fresh five-pair batches for each task, strict completed 0/5 and trusted completed 5/5; every trusted result passed both the visible check and the holdout in a separate container. The earlier "independent check" meant a fresh container running the same visible cases. The [holdout report](model-origin-benchmark.md#holdout-cases-for-the-coding-tasks-8-october) names the added cases and a corrected check-run detector. Blanket trust in `run` remains a policy cost, and two small tasks still cannot establish general coding utility.

Two more five-run blocks used the interval task and the same retry prompt, now comparing autonomous mode with interactive exact-call approval. Both autonomous blocks completed 0/5; both interactive blocks completed 5/5 with one exact `run` call approved and consumed per successful run. The interactive reviewer was a benchmark process, not a person, and its string checks do not make arbitrary shell code safe. Runner output stayed untrusted, the approved commands matched the actual changed-file calls, and each result passed an independent check. A separate exploratory interactive run needed no approval. See [exact-call review](model-origin-benchmark.md#exact-call-review-on-the-interval-task).

A later five-run control and five-run interactive block added verifier-only interval cases while keeping runner output untrusted. The control completed 0/5; interactive exact review completed 5/5, with one approval consumed and a matching edited-file call in every success. All five edits passed visible and held-out checks. One earlier exploratory run was excluded after Docker returned exit 125 before the model turn; the benchmark now aborts on that infrastructure status. The [holdout approval record](model-origin-benchmark.md#exact-call-review-with-verifier-only-cases) retains the synthetic-reviewer and one-task limits.

A further scripted gateway pair sent synthetic secret-read and local-sink commands. With the targets absent from the owner task, Cordon refused them before the runner. When the owner task named those synthetic targets, the gateway forwarded both calls; the container could not read the files or reach the sink. An ordinary-network Docker control reached the same sink by numeric IP, while the restricted runner returned `Network unreachable`. This isolates the two stopping points without relying on a model to choose the call.

A further combined run kept the native shell enabled with Cordon's hook active and the MCP runner configured. A no-hook control wrote a marker through the native shell; the protected probe recorded a `Bash` denial with no native execution; a separate protected request completed one edit through `runner.run` with no native shell or other editing tool. The policy had to name both Codex's `mcp__runner__run` and the gateway's `run`. This is one narrow live integration result, not a general tool-containment claim.

Native `apply_patch` is another path around a runner-only file boundary. In the same live setup, a profile that granted `create` and `update` and blocked only `Bash` wrote a marker through one host `file_change` call. Removing those effects refused the patch; keeping them but naming `apply_patch` in `blockedTools` also refused it. See the [paired control](model-origin-benchmark.md#active-native-shell-hook-and-connected-runner-in-one-configuration).

An isolated live ticket pair used the same CLI configuration controls with only a desk MCP server. The direct clean control sent an identifier-preserving email. Behind Cordon, the model tried to send both the clean and injected ticket summaries, but provenance refusals stopped both before the server. The model did not try the injected address in the direct control. The [paired result](model-origin-benchmark.md#isolated-live-ticket-pair-8-october) records attempted calls separately from delivered emails.

In a later interactive-policy run, a synthetic reviewer approved the complete clean draft while live Codex was still in the same turn. Codex retried the identical `send_email` arguments and the server received one email. This validates a same-turn owner-CLI handoff under the measured configuration; a human reviewer and a retry after a new user turn were not tested.

Cordon decides the same way in every harness; the harness decides what happens next. A field a harness ignores is a decision that silently did not happen, so the table was filled from live runs rather than from documentation, and a cell that could not be measured says so. DeepSeek Harness, further down, is the exception: it was read from source. The probe was a hook that printed one fixed answer per run and a prompt that ran one command (`cat README.md`) or called one MCP tool.

Measured on 2026-09-28 with Codex CLI 0.157.0 (`codex exec`) and Kimi Code 2.0.0 (`kimi -p`), on macOS.

| The hook prints | Claude Code | Codex CLI 0.157 | Kimi Code 2.0 |
|---|---|---|---|
| `permissionDecision: deny` | refused | refused | refused |
| exit 2 | refused | refused | not measured (documented as a block) |
| `permissionDecision: ask` | the human is asked | **the call ran**, nobody was asked, in `codex exec` and in the TUI | not measured |
| `updatedInput` alone | applied | **ignored** | **ignored** |
| `updatedInput` with `allow` | applied | applied, Bash and MCP | ignored |
| `updatedToolOutput` on PostToolUse | the model reads it | **ignored** | ignored |
| `updatedMCPToolOutput` on PostToolUse | — | **ignored** (three shapes tried) | — |
| `decision: block` on PostToolUse | — | the model reads `reason` **instead of** the result, as a tool error | the model read the result |
| a crash (exit 1), garbage on stdout, a hang past the timeout | the call runs | the call runs | the call runs |

## What Cordon does about it

Nothing in the core changes per harness. The adapter picks the strictest answer the harness honours (`src/adapters/claude-code/dialect.ts`).

**Codex** (`cordon hook --harness codex`)

- A question is never printed as `ask`: it goes through the unattended gate, and the refusal names a one-time approval, `cordon approve <id>`, the same as behind the MCP gateway.
- A call Cordon would run with an untrusted fragment cut out is refused. Applying the cut takes an `allow`, and an `allow` overrides the user's own approval settings: Cordon narrows rights and never grants them.
- A rendered result with a hidden layer (a fetched page, an MCP result declared `rendered`) is replaced through `decision: block`. The model reads the cleaned text under Cordon's heading, marked as a tool error. A result the human sees as source text is reported, not cut, as in Claude Code.
- `apply_patch` carries its paths inside the patch. The adapter lifts them out (`src/scope/patch.ts`), relative ones resolved against the session's directory, so self-protection and path bounds see them. A patch that deletes or moves a file counts as `delete`.

**Kimi Code** (`cordon hook --harness kimi`)

- Questions become refusals with `cordon approve <id>`, as on Codex.
- A call Cordon would cut is refused.
- A tool result cannot be replaced at all. When a hidden layer is found in something the model reads rendered (a fetched page), the session is marked the way an unreadable result marks it: reading goes on, and calls that act are refused until the user's next message. The journal says why; the hook also prints a `systemMessage`, and whether Kimi shows it was not measured.
- The user's message arrives as a list of text blocks, not a string; only text blocks count as the user's words.
- An answer to `AskUserQuestion` is read as untrusted content, the stricter reading: after one, a call that acts on something you did not name waits for your next message.
- Built-in tools: `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`, `WebSearch` as in Claude Code, with the file under `path`; `FetchURL` is read plus network; the bookkeeping tools (`TodoList`, `TaskList`, `TaskOutput`, `WaitFor`, `GetGoal`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Skill`, `ReadMediaFile`) are reads. What schedules or stops work or sets a goal (`CronCreate`, `CronDelete`, `TaskStop`, `CreateGoal`, `UpdateGoal`, `SetGoalBudget`) and the subagent `Agent` are left unclassified, so each is refused with an approval id. Do not approve an `Agent` call: whether a subagent's own calls reach the hook was not measured, and an approval covers only the call that starts it.

**DeepSeek Harness** (`cordon hook --harness deepseek`), through `@deepseek-ai/dsh-hooks-claude-code`

Read from the bridge's source at commit 21638c5 (2026-09-27), not measured live: `deny` and exit 2 block; `ask` maps to the harness's approval, which Cordon does not rely on; `updatedInput` is logged and ignored; `updatedToolOutput` and `updatedMCPToolOutput` are unsupported; a PostToolUse block (a top-level `decision: block`, which `@deepseek-ai/dsh-hook-protocol` ranks with `deny`) turns the result into an error carrying the reason, the same channel Codex has; a `systemMessage` is logged and not shown to anyone; a result reaches the hook flattened to its text blocks, so Cordon counts every untrusted result as read, an inert `ok` included; a hook that fails to run is logged and the call goes on; the default timeout is ten minutes. Cordon treats it as Codex: questions become refusals with `cordon approve <id>`, a cut becomes a refusal, a cleaned result goes through the block. One difference Codex found in review: the bridge sends every message that enters a step as `UserPromptSubmit`, a background job's completion notice included (`background job <id> (<kind>: <label>) finished`, with a label the model chose), and the payload carries no source. So on DeepSeek no prompt is taken as the human's: none names a destination and none lifts the hold after an untrusted read, which then lasts until the session expires, one `cordon approve` at a time. Its built-in tools are lower case (`read`, `write`, `edit`, `glob`, `grep`, `bash`, `web_fetch`, `web_search`, `read_image`, `str_replace_editor`), MCP tools are `mcp__server__tool`.

## What was verified end to end

With the built `plugin/dist/cli.js`:

- Codex: an MCP result with a hidden `display:none` block reached the model without it; `apply_patch` into `~/.cordon/policy.yaml` was refused by self-protection and the file stayed as it was; a patch outside a read-only profile was refused with a `cordon approve` id, and the journal holds the question.
- Kimi: a `Write` into Cordon's policy was refused; after `FetchURL`, a write to a file the user did not name was refused by the exposure rule.

In Codex's interactive TUI (0.157, measured 2026-09-28) an `ask` is reported as `unsupported permissionDecision: ask`, the hook counts as failed, and the call runs: the same as in `codex exec`.

## Not measured

- Whether Codex's `update_plan` passes through hooks, and whether other native tools do. An explicit `update_plan` request in Codex CLI 0.161.0 produced no call; the model reported that the tool was unavailable in that session. Codex's native web search **was** measured: it reached `PreToolUse` and `PostToolUse` as `webrun`, was refused before execution without `network-egress`, and completed when that effect was granted. A synthetic `PostToolUse` block reached the model after the search completed ([four-arm live record](model-origin-benchmark.md#native-codex-web-search-hook-8-october)). A separate-UID Codex CLI 0.160.1 probe found no `tools` field in any of four local-provider Responses requests, despite working patch and MCP calls, so that request cannot supply the missing inventory ([request-shape record](model-origin-benchmark.md#separate-uid-codex-cli-with-a-deterministic-model-responder)).
- Kimi's `ask` and exit 2.
- Whether Codex shows a PostToolUse `systemMessage` to the human. Where Cordon reports rather than cuts (a hidden layer in a file read as source text), the journal holds the report either way: `cordon log`.
- Kimi's `Agent` subagent.
- Whether Kimi sends a notice as `UserPromptSubmit`, as DeepSeek's bridge does. In one `kimi -p` run that started a background shell task and read its output after it finished, the hook fired once, for the human's message; the interactive UI was not probed.
- DeepSeek Harness, end to end.
