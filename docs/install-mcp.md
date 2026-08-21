# Cordon as an MCP gateway

`cordon mcp` puts Cordon between an MCP host (Claude Desktop, Cursor, VS Code, a hand-written agent) and an MCP server, as a stdio proxy. The client's config points at Cordon instead of the server, and Cordon starts the server itself:

```
cordon mcp -- npx server-x
```

The transport is JSON-RPC 2.0 over newline-delimited JSON, implemented by hand: no new dependencies, one upstream server per gateway process. Several servers means several config lines, each with its own `cordon mcp`.

## Configuration

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`) share the shape. Where you had:

```json
{
  "mcpServers": {
    "shop": { "command": "npx", "args": ["-y", "server-shop"] }
  }
}
```

you now write:

```json
{
  "mcpServers": {
    "shop": { "command": "cordon", "args": ["mcp", "--", "npx", "-y", "server-shop"] }
  }
}
```

The `--` separator is mandatory: without it the server's flags would be read as Cordon's own.

## What is intercepted

| MCP message | What the gateway does |
|---|---|
| `tools/list` (response) | every tool description is observed as untrusted content; the hidden layer is cut before the model sees the list (tool poisoning lives exactly there) |
| `tools/call` (request) | the call goes through the gate: allow passes it to the server, rewrite forwards it with the untrusted fragment cut out of the arguments, deny never reaches the server at all — the model gets a `CallToolResult` with `isError: true` and the reason |
| `tools/call` (response) | text blocks are observed and substituted with the cleaned text; a block without text (an image, audio) cannot be cleaned, so the session is marked and the next consequential call escalates |
| `resources/read`, `prompts/get` (responses) | the text is observed the same way; `prompts/get` is the classic vector — the server writes what lands in the conversation as if it were the user's own words |
| everything else | passed through unchanged |

All decisions are made by the same core the hooks use; the gateway holds no security logic of its own.

## The policy on this transport

There are no user turns over MCP: the model's conversation with the human happens on the host, past the gateway. Two consequences follow.

**The certificate is the policy profile for the whole run.** Nothing widens or narrows it, and there is no `cordon: scope` directive — MCP does not carry user messages.

**The exposure exemption needs a written task.** After reading untrusted content, a consequential call escalates unless the human named its destination. Over MCP the human never speaks, so the naming is written down in the policy up front:

```yaml
task: change the price of item 99887766 to the seasonal one
```

Atoms — links, paths, identifiers — are extracted from the task text by the same function that extracts them from user messages, and the exemption compares a call's targets against them. Without a `task`, every consequential call under the exposure mark escalates, which is the honest default for a run nobody described. A non-string `task` is a load error, not a silent default.

`toolsReturn` works as everywhere else: an MCP tool's result is treated as source by default (the hidden layer is not stripped, the finding is named in the journal), and `toolsReturn: <tool>: rendered` switches stripping on for the tools whose output the human sees rendered.

## What the gateway does not cover

- **The harness's built-in tools go past MCP.** Read/Write/Bash in Claude Code or Cursor are not MCP calls and never cross the gateway. The gateway covers MCP tools, not the host. For Claude Code the two complement each other: the hooks cover the built-ins, the gateway covers the servers.
- **The exposure mark is not lifted inside a session.** On the hooks a new user message lifts it, on the argument that the human has seen the turn's outcome. Over MCP no message ever arrives, so the mark stands for the life of the process. The recipes: one gateway (one server entry) per task, restarted between tasks — a restart starts a clean session — or `exposure: false` with the price named by `cordon doctor`.
- **One upstream per process.** There is no multi-server routing; the client's own server list does that job.

## The direction of failure

Better than the hooks', and worth saying out loud. A crashed or timed-out hook reads as "let it through" on both coding harnesses. A dead gateway is a dead MCP server: calls simply do not go through, and the host shows the error. A broken line from the upstream, a dead upstream, an unusable state directory — each stops the gateway loudly instead of degrading it into a proxy that no longer checks anything. Fail-open by timeout does not exist here by construction: the gateway sits inside the pipe, and nothing reaches the model without passing through it.

One exception, honestly named: a refusal arrives as a tool result with `isError: true`, and what the model does with that text is the model's business. The call itself did not happen — that part is guaranteed.
