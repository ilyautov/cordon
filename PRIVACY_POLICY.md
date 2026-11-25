# Privacy

Cordon stands between untrusted text and your agent's actions. To do that it has to remember what it read. This page says exactly what it remembers, where it lies, how long it stays and who else can see it. Every claim here is checkable by reading the source, and the paths are given so you can check.

## Network traffic

Policy checks, content scanning and provenance tracking run locally. Cordon has no telemetry, crash reporting or account.

With `cordon mcp --url URL`, the gateway sends MCP traffic to the configured endpoint. This includes client information, discovery and lifecycle messages, allowed tool names and arguments, and any session ID the endpoint assigns. The endpoint operator sees the connection and determines how long it retains the requests. The gateway returns observed results to the local host. [HTTP configuration and supported transports](docs/install-mcp.md#remote-streamable-http-endpoints)

## What is written to disk

Everything lives under `~/.cordon`, or under `$CORDON_HOME` if you set it. Nothing is written outside that directory except the journal, whose path you choose yourself.

| Path | What is in it | How long it lives |
|---|---|---|
| `policy.yaml` | Your configuration. Cordon reads it and never writes it, except `cordon doctor --self-check`, which writes a throwaway policy into a temporary directory of its own. | Until you delete it |
| `sessions/<id>.json` | The turn counter, the provenance store, the "the hidden layer could not be stripped" mark, and the scope narrowing you asked for with a `cordon: scope` directive. | Removed after 24 hours without use |
| `drafts/<id>.json` | The text of the answer the model is currently composing, accumulated from display deltas, up to 200 000 characters. | Removed after 1 hour without use |
| `mcp-pins/` | Server identity (command or canonical endpoint URL), pinned tool declarations and pending changes. | Until reset or superseded |
| `last-sweep` | An empty file. Only its modification time matters: it keeps the cleanup from running on every event. | Permanent, zero bytes |
| the journal, at the path in `notify.file` | One JSON line per decision. | Until you delete it. Cordon never rotates or trims it |

The sessions and drafts directories are created with mode `0700`, the files inside them with `0600`. That is deliberate rather than decorative: the provenance store holds pieces of what was read.

### What "pieces of what was read" means

The provenance store is how Cordon knows that an argument to a tool call came out of a web page rather than out of your instruction. To do that it keeps, per source:

* **atoms** taken from the text: links, file paths, e-mail addresses, and alphanumeric identifiers of eight characters or more that contain at least one digit;
* **hashes of 32-character windows** of the text, taken every 8 characters, so that a verbatim fragment can be recognized later.

The atoms are stored as they appeared in the text. If a page you read contained an e-mail address or an order number, that address or number is in the file. The window hashes are not reversible into the text, but they do confirm a fragment you already have.

The draft file is different and blunter: it holds the answer text itself, in the clear, because the footer has to compare the finished answer against the sources word by word.

### What is in the journal

Per line: the timestamp, the decision (`allow`, `deny`, `notice`), the name of the tool, the reason in words, and the label of the source that caused it when one is known. The arguments of the call are not written. The content that triggered the decision is not written.

The journal exists because autonomous mode is only half done without it: a call blocked at three in the morning that nobody was told about is, to the owner, indistinguishable from a call that never happened. It is off by default; you turn it on by naming a file in `notify.file`.

### The file names

A session file is named from the session identifier the harness gives Cordon, stripped to letters, digits, `_` and `-`, cut to 64 characters, plus the first 16 hex characters of its SHA-256. The identifier comes from the harness and not from you; Cordon neither invents nor stores anything about your person.

## What Cordon reads

Hooks read the event from the harness, including tool names, arguments, results, prompts and answer fragments. The MCP gateway also reads declarations and responses from the configured upstream server. Cordon opens no files of yours on its own initiative. The one exception is `cordon scan <file>`, where you name the file yourself.

## Deleting everything

```bash
rm -rf ~/.cordon
```

If you set a journal path outside `~/.cordon`, delete that file too. An HTTP endpoint may retain requests it received according to its own policy.

## What this page does not cover

Cordon is a layer inside somebody else's harness. What Claude Code, Gemini CLI or a model vendor does with your prompts and the tool results is their policy, not this one. Cordon does not reduce what they receive and does not intercept their traffic; it changes only what the model is shown, and it changes it on your machine before the harness sends it on.

Questions about this page: open an issue. Something you would rather not write in public: the **Security** tab, **Report a vulnerability**, as described in [SECURITY.md](SECURITY.md).
