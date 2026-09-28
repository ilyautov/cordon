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

Then, in a scratch directory, ask the agent to read https://example.com and save a summary to a file whose name it picks itself. Under `coding`, which asks in doubt, the write must be refused with a `cordon approve <id>` line, because the file was not named by you after an untrusted read, and `cordon log --last 1` must show it. (Under the autonomous `locked` profile it is refused too, with no id: nobody is asked there.)

## How it differs from Claude Code

- **No questions.** In `codex exec`, measured, Codex puts a hook's `ask` to no one; the interactive TUI was not measured, and Cordon does not rely on it either way. Every call Cordon would ask about is refused with a one-time approval: run `cordon approve <id>`, and the same call, retried in the same session, goes through once.
- **No silent cut.** A call Cordon would run with an untrusted fragment cut out is refused instead, because Codex applies changed arguments only next to an explicit `allow`, which would override your own approval settings.
- **A cleaned result looks like a tool error.** A result the model reads rendered (a fetched page, an MCP result declared `toolsReturn: rendered`) with a hidden layer is replaced through Codex's block channel: the model reads the cleaned text under Cordon's heading. A file or command output the human sees as source text is not cut; the layer is reported, as in Claude Code.
- **A crashed or hung hook lets the call through.** Same as Claude Code, which is why the hook is synchronous and its bundle ships prebuilt.

## Uninstalling

Remove the three entries from `hooks.json`, then `npm uninstall -g @ilyautov/cordon`. `~/.cordon` holds the policy, the journal and session state; delete it by hand if you want them gone.
