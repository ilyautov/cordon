# Installing Cordon in DeepSeek Harness

DeepSeek Harness (`dsh`) runs Claude Code command hooks through its bridge plugin, `@deepseek-ai/dsh-hooks-claude-code`. Cordon plugs into that bridge with one command. What the bridge does with the answer was read from its source, not measured on a live run; see [harnesses.md](harnesses.md).

Node 22 or newer is required.

## Installation

```bash
npm install -g @ilyautov/cordon
cordon init --profile coding
```

Write a hooks file, for example `~/.cordon/dsh-hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "cordon hook --harness deepseek", "timeout": 5 }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "cordon hook --harness deepseek", "timeout": 5 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "cordon hook --harness deepseek", "timeout": 10 }] }]
  }
}
```

Set `timeout` on every entry. Without one the bridge waits ten minutes for a hook that hangs.

Mount the bridge with `configPath` pointing at that file, in your profile's `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`web` for `dsh web`), as its README shows:

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: /Users/you/.cordon/dsh-hooks.json
```

The bridge reads the file once at start. Restart `dsh` after changing it.

## Checking that it works

```bash
cordon doctor
```

Then, in a scratch directory, ask the agent to read https://example.com and save a summary to a file whose name it picks itself. Under `coding`, which asks in doubt, the write must be refused with a `cordon approve <id>` line, because the session read something untrusted and no message counts as yours here (see below), and `cordon log --last 1` must show it. (Under the autonomous `locked` profile it is refused too, with no id: nobody is asked there.) If the file gets written, the bridge is not mounted: it logs a warning and runs no hooks when it cannot read its config.

## How it differs from Claude Code

- **No questions.** The bridge maps `ask` to its own approval, but whether anyone answers depends on how `dsh` is run, so Cordon does not rely on it. Every call Cordon would ask about is refused with a one-time approval: `cordon approve <id>`.
- **Your messages do not count as yours.** The bridge sends every message that enters a step as a prompt, a background job's completion notice included, and does not say where it came from. The notice carries a label the model chose, so Cordon takes no prompt as your words: a file you name in chat is not a named destination, and once the session has read something untrusted every call that acts is refused with a `cordon approve <id>` line until the session expires. Reading goes on as usual.
- **No silent cut.** The bridge logs changed arguments and ignores them, so a call Cordon would cut is refused.
- **A cleaned result looks like a tool error.** A rendered result with a hidden layer (a fetched page, an MCP result declared `rendered`) is replaced through the bridge's block, which the harness turns into an error result carrying the cleaned text.
- **Nothing reaches you in the session.** The bridge logs a hook's `systemMessage` and shows it to no one. What Cordon found in a file that was read, which it reports rather than cuts, is only in the journal: `cordon log`.
- **Only text reaches the hook.** The bridge flattens a result to its text blocks, so anything else in it reaches the model without Cordon seeing it. Cordon therefore counts every untrusted result as read, even a bare `ok`, which elsewhere leaves the session unmarked.
- **A hook that fails lets the call through**, as in every harness measured.
- `str_replace_editor` views, creates and edits through one tool, so it is classed as read, create and update together: a read-only profile refuses its `view`, and `read` does the same job.
