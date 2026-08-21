# Cordon as a LangChain middleware

For agents built on LangChain.js `createAgent`, Cordon ships as a middleware — the same three axes as the hooks and the MCP gateway, decided by the same core:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from 'langchain'
import { createCordonMiddleware } from 'cordon/dist/adapters/langchain/middleware.js'
import { loadPolicy } from 'cordon/dist/policy/load.js'

const cordonHome = process.env.CORDON_HOME ?? join(homedir(), '.cordon')

const agent = createAgent({
  model,
  tools: [readPage, updatePrice],
  middleware: [
    createCordonMiddleware({
      policy: loadPolicy(cordonHome),
      cordonHome,
      sessionId: 'shop-bot',
    }),
  ],
})
```

`langchain` and `@langchain/core` are peer dependencies: your application already has them, and Cordon's own bundle does not pull them in. The runtime dependency count stays at two.

The package is not published to npm yet, so the import path above resolves to a built checkout today: build from source (`npm install && npm run build:lib`) and import from its `dist/`. The policy is the same `<cordonHome>/policy.yaml` the hooks and the gateway read, with the defaults when the file is absent.

## What is intercepted

The middleware contract maps onto the core's three entries, on two hooks:

| Middleware hook | What Cordon does there |
|---|---|
| `beforeModel` | the text of the last user message goes to `onUserPrompt` — the full mechanics of the hook adapters: the certificate is issued, the exposure and unredacted marks are lifted, atoms named by the user feed the exposure exemption |
| `wrapToolCall`, before the handler | the call goes through the gate. `deny` and `ask` return an error `ToolMessage` with the reason and the handler never runs — the tool is not called. `rewrite` calls the handler with the rewritten arguments. `allow` passes the request through unchanged |
| `wrapToolCall`, after the handler | the result's text is observed: cleaned, recorded into provenance, and substituted when the source's view allows it. The session reading untrusted content is marked, and the gate answers the fact of the read from there |

`ask` lands as a refusal, exactly as in the MCP gateway: the agent loop has no one to put the question in front of and resume, so the interactive mode's question becomes a denial carrying the same reason. The refusal arrives as a `ToolMessage` with `status: 'error'` — the model reads the reason as the tool's output instead of inventing a result.

### One user turn is fed once

`beforeModel` fires on every agent step, and the loop itself never appends human messages — so the last user message sits in the history unchanged while the steps go by. Feeding it on every step would count one human message as several turns, re-issuing the certificate and, worse, lifting the exposure mark a poisoned page just earned. The middleware feeds a message only when it is genuinely new, told apart by position and text: with a checkpointer or full-history invocation the history grows and the last human message moves to a new index; in stateless use, where each invocation carries only the new message, the index stays and the text changes. Object identity would not survive LangGraph rebuilding message objects between steps.

The named blind spot: stateless invocation sending the identical text twice is indistinguishable from a repeated pass, and the second copy is not fed. Skipping is the safe direction — feeding it again would lift a mark without anything having been seen.

## Session and state

State lives under `CORDON_HOME`, or `~/.cordon` when the variable is not set — the same resolution the hooks use. `sessionId` defaults to `langchain`; give each agent its own when several run in one process, because provenance shared between unrelated tasks is worse than provenance per task. A broken state directory throws at middleware creation, not mid-run.

## What the middleware does not cover

- **Only what passes through the agent.** Direct tool invocations outside `createAgent`, code your tools call internally, other agents in the same process without the middleware — none of that crosses a hook.
- **A result that is not a `ToolMessage`.** A tool answering with a `Command` (a state update) produces text the model will read and the middleware never sees. The same holds for content blocks without text — an image, audio, a file reference. Silence would read as a check that happened, so the session is marked and the next consequential call escalates.
- **The `artifact` of a tool message is left untouched.** It is the part of the output the model is not shown; if your application feeds artifacts to a model somewhere else, that path is outside Cordon's sight.
- **The source-influence footer does not exist here.** The middleware never sees the model's rendered answer, only messages — there is no display event on this transport.
- **The default for a tool result's view is `source`.** A LangChain tool's name is chosen by whoever wrote the tool, so it authorizes nothing: the hidden layer is stripped only where the human declared `toolsReturn: <tool>: rendered` in the policy. Undeclared tools keep their result intact, and a finding in one is written to the journal — the channel the agent cannot reach.
- **`langchain` v1.x only.** The middleware API (`createMiddleware`, `wrapToolCall`) is the v1 contract; the v0.x agent executors have no equivalent interception point.

## The direction of failure

`gate` never throws — a core error is a `deny` by construction. A failure while observing a result propagates out of the hook, and LangChain turns a middleware error into an error `ToolMessage`: the model sees a failure, not a silently unchecked result. A failure while taking in the user's message stops the run loudly, because both quieter directions are worse at the one moment the human's words are being read.
