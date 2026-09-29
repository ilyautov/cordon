# Cordon for Claude Code

**Your agent reads anything. It takes orders only from you.**

A prompt-injection firewall with no AI inside. Web pages, emails, issues, documents, tool results and MCP tool descriptions can all carry instructions aimed at your agent. Cordon lets the agent read them and stops it acting on them: a call goes through, waits for your yes, or is refused, and the reason names where the instruction came from.

Plain code decides. There are no model calls and no network requests in the hook, so it cannot be talked round, and every decision can be checked by reading the source.

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

`/hooks` shows that the four events are registered. Whether the mechanism works is answered by `cordon doctor`; see [docs/install.md](https://github.com/ilyautov/cordon/blob/main/docs/install.md) for running it from the installed plugin.

## Policy

With no policy the agent may only read and summarize, and anything else is refused: the default is meant to be safe rather than convenient. Widening it is a deliberate act, for example `npx @ilyautov/cordon init --profile coding`, which asks you in doubt instead of refusing. The profiles and every setting are described in [docs/install.md](https://github.com/ilyautov/cordon/blob/main/docs/install.md).

## Why the bundle is committed

An installed plugin has no `node_modules` next to it, and Claude Code reads a crashed hook as "let it through". So `dist/cli.js` ships prebuilt with its two dependencies inlined, and the hook is synchronous: a failure has to be loud, never silent.

## License

MIT. Source, tests and the attack corpus: [github.com/ilyautov/cordon](https://github.com/ilyautov/cordon).
