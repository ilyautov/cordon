# Installing Cordon in Codex CLI

Codex CLI (0.157 and later) runs hooks in Claude Code's format, so Cordon plugs into it the same way: one command bound to the user's message, a tool call and a tool result. It sees the shell (`Bash`), file edits (`apply_patch`) and MCP tools. What Codex does differently with the answer is measured in [harnesses.md](harnesses.md).

Node 22 or newer is required.

## Installation

```bash
npm install -g @ilyautov/cordon
cordon init --profile coding
```

Add to `~/.codex/hooks.json` (or a project's `.codex/hooks.json`), merging with any hooks already there:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "cordon hook --harness codex", "timeout": 5 }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "cordon hook --harness codex", "timeout": 5 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "cordon hook --harness codex", "timeout": 10 }] }]
  }
}
```

For a project-local `.codex/hooks.json`, first trust the project so Codex loads its `.codex/` configuration layer. Then open `/hooks` in the Codex TUI and trust the three hook entries. The project layer and the hooks have separate trust checks; [Codex's hook documentation](https://learn.chatgpt.com/docs/hooks?site_variant=chatgpt&translationFallback=zh-Hans) describes both. Until the hook actually runs, `codex exec` can execute native tools without a Cordon journal entry.

An automated scratch probe with Codex CLI 0.160.1 confirmed that both user-level `hooks.json` and a trusted project's `.codex/hooks.json` can block native `Bash` before execution. In the project probe, `--ignore-user-config` removed the saved project trust, so the same hook file was skipped and the command ran. Check the real installation without that flag; see the [four-run record](model-origin-benchmark.md#live-codex-native-shell-hook-8-october).

Both installation paths were also checked in the interactive CLI: after folder trust, `/hooks` showed the three new Cordon entries from the user or project file; they were reviewed and trusted, and a harmless Bash call was refused. A new `codex exec` session kept that trust and refused the call again without any bypass flag. See the [TUI trust record](model-origin-benchmark.md#ordinary-hook-trust-through-the-codex-tui).

For a restricted runner workflow, blocking `Bash` alone does not confine file edits to that runner. In a live scratch control, a policy granting `create` and `update` allowed Codex's native `apply_patch` to write on the host despite `blockedTools: [Bash]`. Omit those effects if the runner is the only intended writer, and block `apply_patch` explicitly as a guard against later policy broadening. If the MCP server is named `sandbox`, name the runner both as Codex sees it (`mcp__sandbox__run`) and as the MCP gateway sees it (`run`) in the policy. See the [paired native-tool control](model-origin-benchmark.md#active-native-shell-hook-and-connected-runner-in-one-configuration).

For the complete boundary and acceptance probes, use the [restricted coding runbook](restricted-coding.md).

## Checking that it works

```bash
cordon doctor
```

Confirm that `cordon log --last 1` gains a new refusal event after the check below. If the journal stays unchanged, check project and hook trust before treating the installation as active.

Then, in a scratch directory, ask the agent to read https://example.com and save a summary to a file whose name it picks itself. Under `coding`, which asks in doubt, the write must be refused with a `cordon approve <id>` line, because the file was not named by you after an untrusted read, and `cordon log --last 1` must show it. (Under the autonomous `locked` profile it is refused too, with no id: nobody is asked there.)

## How it differs from Claude Code

- **No hook questions.** Measured in `codex exec` and in the interactive TUI: Codex reports a hook's `ask` as unsupported and runs the call, asking no one. Every call Cordon would ask about is refused with a one-time approval: run `cordon approve <id>`, and the same call, retried in the same live session, goes through once. For MCP tools, the gateway can instead [hold the original call for owner review](install-mcp.md#wait-for-the-owner-in-the-same-gateway-process); after approval it tells Codex to retry. An isolated live run completed with one review and one retry. Give Codex a tool timeout longer than the gateway's wait. An MCP gateway restarted for another `codex exec` process has a new session ID; approving an old MCP request after the process exits cannot release it in the new process. See [the gateway restart and held-call tests](model-origin-benchmark.md#approval-after-an-mcp-gateway-restart).
- **No silent cut.** A call Cordon would run with an untrusted fragment cut out is refused instead, because Codex applies changed arguments only next to an explicit `allow`, which would override your own approval settings.
- **A cleaned result looks like a tool error.** A result the model reads rendered (a fetched page, an MCP result declared `toolsReturn: rendered`) with a hidden layer is replaced through Codex's block channel: the model reads the cleaned text under Cordon's heading. A file or command output the human sees as source text is not cut; the layer is reported, as in Claude Code.
- **A crashed or hung hook lets the call through.** Same as Claude Code, which is why the hook is synchronous and its bundle ships prebuilt.

## Uninstalling

Remove the three entries from `hooks.json`, then `npm uninstall -g @ilyautov/cordon`. `~/.cordon` holds the policy, the journal and session state; delete it by hand if you want them gone.
