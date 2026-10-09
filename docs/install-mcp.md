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

Model-selected MCP requests outside `tools/call` also need declared effects. For a server whose resource and prompt methods only read data, add the exact method names to the active Cordon policy's `tools` map and grant `read` in the profile:

```yaml
tools:
  resources/read: [read]
  prompts/get: [read]
  completion/complete: [read]
```

Declare `resources/subscribe`, `resources/unsubscribe` and `logging/setLevel` only when the host uses them, with the effects that server actually performs. An undeclared method is refused. `allowedTools` and `blockedTools` apply to these exact method names too. Connection discovery (`initialize`, `tools/list` and the catalog lists) remains available so the host can load the server and show its declarations.

## What is intercepted

| MCP message | What the gateway does |
|---|---|
| `initialize` (response) | server-authored `instructions` are observed as untrusted content before the host receives them. Hidden text is stripped; unsupported result fields or unreadable metadata are withheld as a JSON-RPC error. An ordinary handshake with no instructions keeps its protocol version, capabilities and server identity |
| `server/discover` (response) | the modern MCP discovery response receives the same treatment for its optional `instructions`. Its supported versions, capabilities, cache hints and server identity metadata are retained when readable; unsupported result fields or unreadable metadata are withheld |
| server-origin requests and notifications | contentless `ping` is answered by the gateway. Server requests for sampling, elicitation or other host actions get a JSON-RPC method error before reaching the host. `notifications/message` data is observed and cleaned; contentless tool, prompt and resource list-change signals pass. Unknown or unreadable notifications are withheld and logged |
| `tools/list` (response) | tools are compared against the pins for this server (below), and a changed or new tool is removed from the list; every remaining description, top-level title and annotation title is observed as untrusted content. Schema descriptions and titles are cleaned, while every other string and property name in `inputSchema` and `outputSchema` is checked without rewriting it: if cleaning would change a value such as `default`, `const`, `enum`, `examples`, `pattern` or `required`, the whole list is withheld so the advertised schema cannot silently diverge from the server's. Current MCP `resultType`, cache hints and tool icons are accepted with validation; icons are pinned, and an icon needing cleaning withholds the list. Schemas deeper than 16 levels, over the node budget, unknown tool fields, malformed title, schema or annotation fields, unexpected result fields and unscannable metadata are withheld as JSON-RPC errors. The hidden layer is cut before the model sees the list, because tool poisoning lives exactly there |
| `resources/list`, `resources/templates/list`, `prompts/list` (responses) | server-authored discovery text is observed before the host can show it to the model. Hidden text is stripped, and malformed or unknown result shapes are withheld as JSON-RPC errors. Pagination cursors and URI templates remain intact |
| `tools/call` (request) | the call goes through the gate: allow passes it to the server, rewrite forwards it with the untrusted fragment cut out of the arguments, deny never reaches the server at all — the model gets a `CallToolResult` with `isError: true` and the reason. Malformed arguments and unexpected action fields are refused before the server sees them. A forwarded request contains exactly the name and arguments the gate checked; optional `progressToken` is preserved, while other metadata is dropped |
| `resources/read`, `prompts/get`, `completion/complete`, subscription and log-level requests | these model-selected or state-changing methods go through the same certificate and exact-name tool lists as `tools/call`. An undeclared method, a missing effect, an unexpected parameter or a denied request returns a JSON-RPC error before the server sees it. Valid progress metadata survives; other request metadata is dropped. A narrowed request is refused because these methods have no safe result slot for a rewrite notice |
| `tools/call` (response) | text blocks, including their additional fields, `structuredContent` and `_meta` are observed; hidden text is stripped when the policy permits substitution. Current MCP `resultType: "complete"` is accepted; `input_required` is withheld pending a separate multi-round-trip design. A non-object result, a missing or malformed `content` array, unexpected fields beside `result`, unknown nested shapes and text that needs cleaning in source view are withheld as `isError`, and the next consequential call escalates. A block without text (an image, audio) cannot be cleaned, so the session is marked and the next consequential call escalates |
| JSON-RPC error responses | the server-authored message is observed as untrusted content. A hidden message is cleaned for a rendered tool and withheld for a source-view tool, whose policy forbids substitution. Inspectable `error.data` is cleaned when possible; hidden instructions in its property names, opaque data, malformed error fields and extra response fields are withheld before the host sees them. A withheld error marks the session so a later consequential call escalates |
| `resources/read`, `prompts/get` (responses) | all readable result fields are observed, including metadata and text beside a content block. Missing required arrays, unknown text shapes and unexpected JSON-RPC fields are withheld as an error, and the next consequential call escalates. A resource is classified by the URI the host requested; the server cannot make an untrusted read trusted by changing the returned URI. Binary media is forwarded and marks the session as unredacted. `prompts/get` is the classic vector — the server writes what lands in the conversation as if it were the user's own words |
| `completion/complete` (response) | completion values and metadata are observed before the host receives them. A hidden layer in a value or property name, or an unsupported result shape, withholds the response and marks the session |
| other host requests and server responses | only named core request methods reach the server. An extension method returns JSON-RPC `-32601` until it has an explicit effect rule; unknown host notifications are withheld too. Responses without a dedicated handler pass only when their readable content and serialized property names survive observation unchanged; opaque or changed results are withheld as JSON-RPC errors. A contentless result such as `logging/setLevel` remains intact |

Action decisions come from the same core the hooks use. The gateway handles MCP framing, metadata inspection and refusal of unreadable protocol shapes before they reach the host.

## Tool pinning

A server you connected and trusted can change a tool's description on any later start. This is the rug pull. The model reads descriptions as instruction, and you never see them. Whether the new wording is malicious is a question about meaning, which Cordon does not ask. That the wording changed is a fact, so the gateway acts on the fact.

On a server's first start the gateway pins every tool: its name, raw description, input schema and, when present, title, annotations, output schema and icons, hashed. The pins are stored in `~/.cordon/mcp-pins/`, one file per server command. On every later `tools/list`, a tool whose fingerprint differs from its pin is **held**, and so is a tool that was not there when the server was pinned. Existing pins for tools without these optional fields remain valid; an already pinned tool that has them is held once until the owner approves its expanded fingerprint:

- it is removed from the list the host receives, so the model never reads the changed text;
- a call to it is refused by name, and the refusal says which server to review;
- the journal gets an `mcp-drift` event naming the tool and the server.

After you have looked at the server, approve it:

```bash
cordon mcp approve -- npx -y @modelcontextprotocol/server-everything
```

Spell the command exactly as the host starts it, because the pins are keyed by it. The next start pins the tools afresh. `cordon doctor` shows whether pinning is on and how many servers are pinned. A legitimate server upgrade also changes descriptions, and it is held the same way: the cost is one approve per upgrade. `mcp: {pin: false}` in the policy switches pinning off.

### A tool that imitates another server's tool

Each gateway fronts one server, but all of them pin into the same `~/.cordon/mcp-pins/`. So on every start the gateway compares its server's tool names with the names every other server was pinned with. A name that reads the same at a glance and is not the same, such as `re\u0430d_file`, where `\u0430` is a Cyrillic letter, next to another server's `read_file`, or `read_fi1e`, is held like a changed tool, with its own reason in the refusal and the journal. Approving the server does not release it, because approval does not make it a different name. Remove the server or have its author rename the tool.

The same name on two servers is not held. `search`, `fetch` and `read_file` exist on many servers, and the host tells them apart. A different spelling such as `readFile` next to `read_file` is not held either: only a lookalike character is an imitation. The comparison is with servers that have already started once, and the plain name of a pair is never the one held. If the imitating server was pinned first, the honest server's `read_file` still goes through, and the imitation is held when its own gateway next starts and meets the honest pin. Two lookalike names with no plain one between them are both held. Characters that render as nothing (zero-width spaces and joiners, soft hyphens, variation selectors) are ignored in the comparison. The lookalike table covers Cyrillic, Greek, Armenian, Cherokee and the Latin letters NFKC leaves alone; it is not Unicode's full confusables list, so a rarer script can still pass.

The pins are files in your home directory, and an MCP server is a program running as you. A server that wants to can rewrite them, so pinning and this check assume a server that lies in what it lists, not one that attacks the machine it runs on. For that, run the server in a sandbox.

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

In practice the mark is set before the first call. Tool descriptions are untrusted text the model reads, and poisoned descriptions are usually plain visible text, not a hidden layer. So the first `tools/list` marks the session. Through the gateway, a write, a send or a shell call is therefore always a question in interactive mode, answered as below, and a refusal in autonomous mode, unless `task` names its target. That is the price of the transport, and it is deliberate. A description is where the server's author speaks to your model, and pinning makes it stable, not trustworthy. A non-string `task` is a load error, not a silent default.

### A question with nobody to ask

MCP and a LangChain agent loop carry no built-in way to put a question in front of a person and resume. By default, an interactive question becomes a refusal that names a one-time approval:

```
Cordon refused the call to update_price: … Nobody is here to ask, so the call is refused; the owner can allow
this exact call once with "cordon approve 3f9c0a12b7e4d651", and retrying it unchanged then goes through
```

The owner sees what waits with `cordon approve`, the arguments of each call included, and allows one call with `cordon approve <id>`. The listing cuts arguments longer than 4000 characters; the request file it names keeps every one of them, and such a call is approved only with `cordon approve <id> --read`, after the owner has read the file. Arguments are listed with their keys sorted, so without this a long `body` would push the `to` past the cut, and the owner would approve a recipient they never saw. The CLI prints direction-changing and zero-width characters as `\u` escapes rather than letting them alter the displayed recipient or command; the stored arguments remain unchanged. The journal carries the same id. The id is bound to the session, the tool and every argument, so an approval cannot be spent on a different recipient or a changed amount. It is used once, and a request or an approval older than an hour is void. The approval also holds only in the context it was given in, and the id names that context, not the call alone: the rule that asked, how much untrusted content the session had read and what it was, the user's turn, the certificate and the policy. After another untrusted result, readable or not, after a new message from the user, or under a changed policy, the same call is a new question under a new id; the earlier one is void with any approval given to it, and the journal says `approval-void` and what changed. So the owner approves exactly the question they were shown: an id they typed cannot come to mean a question asked after they read it. `cordon approve` shows what the session had read when it asked. Autonomous mode offers no approval: there a refusal means the policy, `destinations` or `task`, is what should change.

Approve while the gateway process is still running, then retry the identical call in that process. Each gateway run receives a fresh random session ID. If an MCP host stops the gateway when an agent turn finishes, approving its pending request later and starting another host process cannot release the old call: the new gateway asks under a new ID. A scripted gateway restart test verifies this refusal even when the policy, read and call arguments are identical. A separate regression starts the gateway twice in one process to reproduce PID reuse: the later run must also refuse the old approval. The old approval stays on disk until it expires, but cannot be spent by the new session. This transport has no supported pause-and-resume handoff across gateway restarts.

### Wait for the owner in the same gateway process

For an attended task, the gateway can hold the original MCP call while the owner reviews it:

```bash
cordon mcp --wait-for-approval-ms 30000 -- <server command...>
```

This is opt-in; without the flag the gateway returns the refusal above. In wait mode, run `cordon approve` in another terminal to see the pending call and its complete arguments, then `cordon approve <id>` (or `--read` for a long request). The gateway tells the agent that the owner approved and asks it to **retry the identical call once**. The held call itself never reaches the upstream server. The retry goes through Cordon's full decision again: a changed policy or another untrusted result can void the approval. If Cordon's wait expires, the host sends MCP `notifications/cancelled`, or the gateway disconnects, the pending request is retired and nothing is forwarded.

Set the MCP host's tool timeout **longer** than Cordon's wait; the retry is a separate tool call. The measured Codex CLI run used a 30-second Cordon wait and a 45-second MCP tool timeout. A host can time out without sending cancellation: in a live control with a one-second host timeout, an earlier design that forwarded the held call after approval sent an email even though Codex reported failure. The implemented wait mode only sends a retry instruction, so that same delayed approval sent no email. An agent that does not retry cannot complete the task. The wait holds one live process; it does not make an old approval valid after a restart. On `codex exec resume`, the new gateway asks under a new ID; the owner can review and approve that new request while the resumed process waits. A live synthetic-review control sent one email after the model retried under the new approval. The owner must have a separate channel to see the request and run `cordon approve`, and the agent must not have access to that channel or CLI.

The approval is the owner's word, and an agent with a shell could try to say it for them. The gate refuses a command that runs `cordon approve`, `cordon mcp approve`, `cordon init`, `cordon policy apply` or `cordon hook`, quotes and backslashes removed first, and an exec after an untrusted read escalates anyway. The check is still crude, the same as self-protection's: a command assembled from variables, or `node -e` calling Cordon's code directly, gets past it before any untrusted read. The boundary that holds is the operating system's: an agent that runs as the same OS user as the owner, with `exec`, can write whatever the owner can. Where that matters, run the agent as a different user, or grant it no shell; where the agent has no shell, it has no way to approve at all.

`toolsReturn` works as everywhere else: an MCP tool's result is treated as source by default (the hidden layer is not stripped, the finding is named in the journal), and `toolsReturn: <tool>: rendered` switches stripping on for the tools whose output the human sees rendered.

## What the gateway does not cover

- **The harness's built-in tools go past MCP.** Read/Write/Bash in Claude Code or Cursor are not MCP calls and never cross the gateway. The gateway covers MCP tools, not the host. For Claude Code the two complement each other: the hooks cover the built-ins, the gateway covers the servers.
- **The exposure mark is not lifted inside a session.** On the hooks a new user message lifts it, on the argument that the human has seen the turn's outcome. Over MCP no message ever arrives, so the mark stands for the life of the process. The recipes: one gateway (one server entry) per task, restarted between tasks — a restart starts a clean session — or `exposure: false` with the price named by `cordon doctor`.
- **The model's answer.** The gateway sits between the client and a server; the answer the model writes never crosses it. A markdown image or a data-carrying link in the answer is the client's to render and the hooks' or the middleware's to catch, not the gateway's.
- **One upstream per process.** There is no multi-server routing; the client's own server list does that job.

## The direction of failure

Better than the hooks', and worth saying out loud. A crashed or timed-out hook reads as "let it through" on both coding harnesses. A dead gateway is a dead MCP server: calls simply do not go through, and the host shows the error. A broken line from the upstream, a dead upstream, an unusable state directory — each stops the gateway loudly instead of degrading it into a proxy that no longer checks anything. Fail-open by timeout does not exist here by construction: the gateway sits inside the pipe, and nothing reaches the model without passing through it.

A response from the upstream with no matching host request also stops the gateway; it cannot carry unobserved content to the host. A JSON-RPC error for a known request is different: its message is observed as untrusted source text, and opaque `error.data` marks the session as unredacted before the host receives it. The next consequential call therefore faces the exposure rule even when the earlier tool failed.

One exception, honestly named: a refusal arrives as a tool result with `isError: true`, and what the model does with that text is the model's business. The call itself did not happen — that part is guaranteed.
