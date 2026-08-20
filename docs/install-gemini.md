# Installing Cordon in Gemini CLI

Cordon installs as an extension. The extension binds one executable file to four harness events: the user's message, a tool call, a tool result, the end of the turn. There is no security logic in the extension; it translates events into the core's contract and prints the decision.

Node 22 or newer is required. No keys, tokens or network access are needed: there are no network requests and no model calls in the hot path, by construction.

## Installation

```bash
gemini extensions install https://github.com/ilyautov/cordon
```

There is no build step. The bundled file `plugin/dist/cli.js` ships in the repository ready to run, one bundle for both harnesses, because an installed extension has neither `node_modules` nor `package.json` next to it, and a file with external imports would crash `node` on the very first event. This harness reads a crashed hook as "pass", so the defence would switch off silently.

From a local clone:

```bash
git clone https://github.com/ilyautov/cordon.git
cd cordon
npm ci && npm run build
gemini extensions link .
```

Installed extensions live in `~/.gemini/extensions`.

## Checking that the hook is in place

```bash
cordon doctor
```

`doctor` answers the question "does the mechanism work" by running a built-in attack sample through both adapters end to end. It does not answer the question "does the harness actually call the hook", and it says so out loud: that is shown by `/hooks panel` inside Gemini CLI. The difference matters. A hook the harness never calls looks, from the outside, exactly like a hook that had no reason to fire, and that is the most dangerous state there is.

## Policy

The policy is shared between both harnesses and lives in `~/.cordon/policy.yaml`. It is deliberately not read from the project's working directory: otherwise a poisoned repository would bring its own file with the mode turned off.

```yaml
mode: autonomous
profile:
  effects: [read, summarize, create]
tools:
  wb_reviews: [read]
  wb_reply: [create]
  wb_update_price: [update, financial]
toolsReturn:
  wb_reviews: rendered
notify:
  file: ~/.cordon/events.jsonl
```

`toolsReturn` declares whether the human sees a tool's result rendered or as source. Without a declaration, an MCP server's result is treated as source and the hidden layer is not stripped from it: the finding is named to the human, but the content reaches the model intact. The default leans that way deliberately — a mistaken substitution corrupts content silently and irreversibly, whereas letting something through is loud and is still caught by the control and data axes.

## What works worse here than in Claude Code

Cordon does not promise identical behaviour on different harnesses. Three differences are listed below, each with its consequence rather than just the fact.

**There is nothing to replace a tool result with.** The `AfterTool` event has no field that would substitute the content: there is only appending alongside the original text, and outright rejection. Appending is fundamentally unsuitable for neutralization — the hidden layer stays where it was and our note stands next to it — so a poisoned result is rejected whole, and the cleaned text travels in the rejection reason.

Consequence for you: a page with a hidden layer does not reach the model at all. On Claude Code the model would have received the cleaned text as an ordinary result and carried on; here it receives a refusal and will most likely try again. The clean part of the page is not lost, but it arrives wrapped in a refusal rather than in a result.

**Any hook failure ends in a pass, not just a timeout.** A crash, garbage on stdout and expired time all mean the same thing here: the hook took no part in the decision, and with no decisions the action is allowed. There is no "this hook is mandatory" flag in the harness configuration at all.

Consequence for you: `cordon doctor` stops being a convenience and becomes part of the defence. Check after every update of Node, of Cordon itself, and of the harness.

**The session identifier survives across processes only when the session is explicitly resumed.** Without it every launch gets a new identifier, and the previous launch's provenance is not found.

Consequence for you: a conversation started afresh starts the data axis from a blank slate. Content read yesterday is not treated as untrusted today, because Cordon does not remember it. This is not a defect in Cordon nor in the harness but the way sessions are built — yet you must know about it: continue long work by resuming the session, not by launching a new one.

## Two more caveats

**Asking the human for confirmation is not used in headless mode.** Judging by the harness source, a forced prompt in a non-interactive run hangs rather than failing with an error. So in autonomous mode Cordon asks nothing at all: it only allows or refuses.

**The hooks API is young.** It appeared in version 0.26.0, and confirmation behaviour has changed since. It is worth pinning the harness version and checking what changed in the events before upgrading.
