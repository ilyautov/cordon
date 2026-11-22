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

Codex runs a new hook only after it is trusted: open `/hooks` in the Codex TUI and trust the three entries. Until then they do not run, and nothing says so in `codex exec`.

## Checking that it works

```bash
cordon doctor
```

To check a native tool call, open a scratch project in the Codex installation you want to test. From an owner terminal in that same directory, using the same Cordon home, run:

```bash
cordon probe codex
```

This requires a configured journal (`cordon init` supplies one). Paste only the returned `prompt` into Codex. It asks for a single native `apply_patch` call to add a harmless marker under a fresh directory in the scratch project. Look for the refusal in the tool transcript, then run the returned `check` command yourself in the original terminal.

Exit 0 means the current journal contains an `apply_patch` self-protection denial for that exact path and the marker is absent. Exit 1 means the evidence is missing, the marker exists, or the check could not read the evidence. If the model skipped the call, the journal rotated, or an earlier policy rule blocked the tool by name, the result is inconclusive. Use a fresh probe for each run. The check covers this native tool call only. A manually replayed hook event can produce the same journal record, so the tool transcript matters.

For a paired allowed and denied write with a JSON result, see the [compatibility matrix](compatibility.md#check-an-installed-version).

## How it differs from Claude Code

- **No questions.** Measured in `codex exec` and in the interactive TUI: Codex reports a hook's `ask` as unsupported and runs the call, asking no one. Every call Cordon would ask about is refused with a one-time approval: run `cordon approve <id>`, and the same call, retried in the same session, goes through once.
- **No silent cut.** A call Cordon would run with an untrusted fragment cut out is refused instead, because Codex applies changed arguments only next to an explicit `allow`, which would override your own approval settings.
- **A cleaned result looks like a tool error.** A result the model reads rendered (a fetched page, an MCP result declared `toolsReturn: rendered`) with a hidden layer is replaced through Codex's block channel: the model reads the cleaned text under Cordon's heading. A file or command output the human sees as source text is not cut; the layer is reported, as in Claude Code.
- **A crashed or hung hook lets the call through.** Same as Claude Code, which is why the hook is synchronous and its bundle ships prebuilt.

## Uninstalling

Remove the three entries from `hooks.json`, then `npm uninstall -g @ilyautov/cordon`. `~/.cordon` holds the policy, the journal and session state; delete it by hand if you want them gone.
