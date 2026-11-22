# Cordon for Claude Code

**Your agent reads anything. You set the rules for its actions.**

A deterministic boundary for agent actions the plugin observes, with no AI inside. Web pages, emails, issues, documents, tool results and MCP tool descriptions can all carry instructions aimed at your agent. Cordon records their origin and gates later calls crossing the hook: a call goes through, waits for your yes, or is refused.

Plain code decides. There are no model calls or network requests in the hook, and each decision can be reproduced from the same input. A modified model can request a harmful call without reading untrusted content; the policy and a separate process boundary must constrain that case.

## What the plugin does

It binds one prebuilt file, `dist/cli.js`, to four events:

- **UserPromptSubmit** records what you asked for. Only your words and your policy decide what the agent may do.
- **PreToolUse** decides on each call: allow, ask you, or refuse. A destination, a file or a command that came from untrusted content and not from you is not trusted to act.
- **PostToolUse** marks what the agent read and strips the hidden layer (invisible characters, mixed-script look-alikes, hidden HTML, encoded blocks) out of rendered results.
- **MessageDisplay** adds a short footer naming the sources that shaped the answer.

State lives in `~/.cordon`: the policy, a journal of decisions, and per-session state that expires.

## Requirements

Node 22 or newer. No keys, tokens or accounts.

## Install

```
/plugin marketplace add ilyautov/cordon
/plugin install cordon@cordon
```

`/hooks` shows that the four events are registered. `cordon doctor` checks the mechanism and active policy, but it cannot prove the host invoked a hook. Check hook trust and run a harmless denial probe in the host before sensitive work; see [docs/install.md](https://github.com/ilyautov/cordon/blob/main/docs/install.md) and the [restricted coding runbook](https://github.com/ilyautov/cordon/blob/main/docs/restricted-coding.md).

## Policy

With no policy the agent may only read and summarize, and anything else is refused: the default is meant to be safe rather than convenient. Widening it is a deliberate act, for example `npx @ilyautov/cordon init --profile coding`, which asks you in doubt instead of refusing. The profiles and every setting are described in [docs/install.md](https://github.com/ilyautov/cordon/blob/main/docs/install.md).

## Why the bundle is committed

An installed plugin has no `node_modules` next to it, and Claude Code reads a crashed hook as "let it through". So `dist/cli.js` ships prebuilt with its two dependencies inlined, and the hook is synchronous: a failure has to be loud, never silent.

## License

MIT. Source, tests and the attack corpus: [github.com/ilyautov/cordon](https://github.com/ilyautov/cordon).
