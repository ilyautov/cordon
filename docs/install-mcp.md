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
| `tools/list` (response) | tools are compared against the pins for this server (below), and a changed or new tool is removed from the list; every remaining description is observed as untrusted content, and so is every `description` and `title` inside the tool's `inputSchema`, at any depth up to 16 levels (a deeper schema marks the session). Strings in `default`, `enum` and `examples` are not observed. The hidden layer is cut before the model sees the list, because tool poisoning lives exactly there |
| `tools/call` (request) | the call goes through the gate: allow passes it to the server, rewrite forwards it with the untrusted fragment cut out of the arguments, deny never reaches the server at all — the model gets a `CallToolResult` with `isError: true` and the reason |
| `tools/call` (response) | text blocks are observed and substituted with the cleaned text; a block without text (an image, audio) cannot be cleaned, so the session is marked and the next consequential call escalates |
| `resources/read`, `prompts/get` (responses) | the text is observed the same way; `prompts/get` is the classic vector — the server writes what lands in the conversation as if it were the user's own words |
| everything else | passed through unchanged |

All decisions are made by the same core the hooks use; the gateway holds no security logic of its own.

## Tool pinning

A server you connected and trusted can change a tool's description on any later start. This is the rug pull. The model reads descriptions as instruction, and you never see them. Whether the new wording is malicious is a question about meaning, which Cordon does not ask. That the wording changed is a fact, so the gateway acts on the fact.

On a server's first start the gateway pins every tool: its name, its raw description and its input schema, hashed. The pins are stored in `~/.cordon/mcp-pins/`, one file per server command. On every later `tools/list`, a tool whose fingerprint differs from its pin is **held**, and so is a tool that was not there when the server was pinned:

- it is removed from the list the host receives, so the model never reads the changed text;
- a call to it is refused by name, and the refusal says which server to review;
- the journal gets an `mcp-drift` event naming the tool and the server.

After you have looked at the server, approve it:

```bash
cordon mcp approve -- npx -y @modelcontextprotocol/server-everything
```

Spell the command exactly as the host starts it, because the pins are keyed by it. The next start pins the tools afresh. `cordon doctor` shows whether pinning is on and how many servers are pinned. A legitimate server upgrade also changes descriptions, and it is held the same way: the cost is one approve per upgrade. `mcp: {pin: false}` in the policy switches pinning off.

Limits:
- This is trust on first use. A server that is poisoned from its very first start is pinned as it is. Its descriptions and calls still go through the sanitizer and the gate, as for any server.
- A pin covers what the server says about a tool, not what the tool does. A server can change its behaviour and keep the same description.
- Changing the command in the host's configuration, for example a new version in `npx server@2`, makes it a new server, and that server is pinned afresh. That change is made by you, not by the server.
- Pins do not expire. An expiry would schedule a re-approval that a server could simply wait out.

## The policy on this transport

There are no user turns over MCP: the model's conversation with the human happens on the host, past the gateway. Two consequences follow.

**The certificate is the policy profile for the whole run.** Nothing widens or narrows it, and there is no `cordon: scope` directive — MCP does not carry user messages.

**The exposure exemption needs a written task.** After reading untrusted content, a consequential call escalates unless the human named its destination. Over MCP the human never speaks, so the naming is written down in the policy up front:

```yaml
task: change the price of item 99887766 to the seasonal one
```

Atoms — links, paths, identifiers — are extracted from the task text by the same function that extracts them from user messages, and the exemption compares a call's targets against them. Without a `task`, every consequential call under the exposure mark escalates, which is the honest default for a run nobody described.

In practice the mark is set before the first call. Tool descriptions are untrusted text the model reads, and poisoned descriptions are usually plain visible text, not a hidden layer. So the first `tools/list` marks the session. Through the gateway, a write, a send or a shell call is therefore always a question in interactive mode and a refusal in autonomous mode, unless `task` names its target. That is the price of the transport, and it is deliberate. A description is where the server's author speaks to your model, and pinning makes it stable, not trustworthy. A non-string `task` is a load error, not a silent default.

`toolsReturn` works as everywhere else: an MCP tool's result is treated as source by default (the hidden layer is not stripped, the finding is named in the journal), and `toolsReturn: <tool>: rendered` switches stripping on for the tools whose output the human sees rendered.

## What the gateway does not cover

- **The harness's built-in tools go past MCP.** Read/Write/Bash in Claude Code or Cursor are not MCP calls and never cross the gateway. The gateway covers MCP tools, not the host. For Claude Code the two complement each other: the hooks cover the built-ins, the gateway covers the servers.
- **The exposure mark is not lifted inside a session.** On the hooks a new user message lifts it, on the argument that the human has seen the turn's outcome. Over MCP no message ever arrives, so the mark stands for the life of the process. The recipes: one gateway (one server entry) per task, restarted between tasks — a restart starts a clean session — or `exposure: false` with the price named by `cordon doctor`.
- **One upstream per process.** There is no multi-server routing; the client's own server list does that job.

## The direction of failure

Better than the hooks', and worth saying out loud. A crashed or timed-out hook reads as "let it through" on both coding harnesses. A dead gateway is a dead MCP server: calls simply do not go through, and the host shows the error. A broken line from the upstream, a dead upstream, an unusable state directory — each stops the gateway loudly instead of degrading it into a proxy that no longer checks anything. Fail-open by timeout does not exist here by construction: the gateway sits inside the pipe, and nothing reaches the model without passing through it.

One exception, honestly named: a refusal arrives as a tool result with `isError: true`, and what the model does with that text is the model's business. The call itself did not happen — that part is guaranteed.
