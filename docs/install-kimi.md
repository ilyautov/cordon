# Installing Cordon in Kimi Code

Kimi Code 2.0 runs hooks with Claude Code's event names and refusal field, so Cordon plugs into it with one command. Kimi cannot replace a tool's result and ignores changed arguments; what Cordon does about that is measured in [harnesses.md](harnesses.md).

Node 22 or newer is required.

## Installation

```bash
npm install -g @ilyautov/cordon
cordon init --profile coding
```

Append to `~/.kimi-code/config.toml`:

```toml
[[hooks]]
event = "UserPromptSubmit"
command = "cordon hook --harness kimi"
timeout = 5

[[hooks]]
event = "PreToolUse"
command = "cordon hook --harness kimi"
timeout = 5

[[hooks]]
event = "PostToolUse"
command = "cordon hook --harness kimi"
timeout = 10
```

`kimi doctor` validates the file.

## Checking that it works

```bash
cordon doctor
```

Then, in a scratch directory, ask the agent to read https://example.com and save a summary to a file whose name it picks itself. Under `coding`, which asks in doubt, the write must be refused with a `cordon approve <id>` line, because the file was not named by you after an untrusted read, and `cordon log --last 1` must show it. (Under the autonomous `locked` profile it is refused too, with no id: nobody is asked there.)

## How it differs from Claude Code

- **No questions.** Every call Cordon would ask about is refused with a one-time approval: `cordon approve <id>`, then the same call, retried in the same session, goes through once.
- **No silent cut.** Kimi ignores changed arguments, so a call Cordon would cut is refused.
- **A hidden layer cannot be removed.** Kimi hands the model a tool's result whatever the hook prints. When a fetched page carries a hidden layer, the model reads it; Cordon then refuses every call that acts until your next message, and the journal names the page.
- **A crashed or hung hook lets the call through**, as in every harness measured.

## Uninstalling

Remove the three `[[hooks]]` blocks, then `npm uninstall -g @ilyautov/cordon`. `~/.cordon` holds the policy, the journal and session state.
