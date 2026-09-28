# What each harness does with a hook's answer

Cordon decides the same way in every harness; the harness decides what happens next. A field a harness ignores is a decision that silently did not happen, so the table was filled from live runs rather than from documentation, and a cell that could not be measured says so. DeepSeek Harness, further down, is the exception: it was read from source. The probe was a hook that printed one fixed answer per run and a prompt that ran one command (`cat README.md`) or called one MCP tool.

Measured on 2026-09-28 with Codex CLI 0.157.0 (`codex exec`) and Kimi Code 2.0.0 (`kimi -p`), on macOS.

| The hook prints | Claude Code | Codex CLI 0.157 | Kimi Code 2.0 |
|---|---|---|---|
| `permissionDecision: deny` | refused | refused | refused |
| exit 2 | refused | refused | not measured (documented as a block) |
| `permissionDecision: ask` | the human is asked | **the call ran**, nobody was asked | not measured |
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

## Not measured

- Codex's interactive TUI: whether `ask` is put to the human there. Cordon does not rely on it either way.
- Whether Codex's own `web_search` and `update_plan` pass through the hooks. If they do, both are unclassified and refused with an approval id. In the probes only `Bash`, `apply_patch` and MCP tools did.
- Kimi's `ask` and exit 2.
- Whether Codex shows a PostToolUse `systemMessage` to the human. Where Cordon reports rather than cuts (a hidden layer in a file read as source text), the journal holds the report either way: `cordon log`.
- Kimi's `Agent` subagent.
- Whether Kimi sends a notice as `UserPromptSubmit`, as DeepSeek's bridge does. In one `kimi -p` run that started a background shell task and read its output after it finished, the hook fired once, for the human's message; the interactive UI was not probed.
- DeepSeek Harness, end to end.
- Codex's hook trust: hooks from a project's `.codex/hooks.json` run only once trusted (`/hooks` in the TUI); the probes used `--dangerously-bypass-hook-trust`.
