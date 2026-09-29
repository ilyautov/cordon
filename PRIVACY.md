# Privacy

Cordon runs on your machine, inside the hooks of the agent harness you use. It has no server, no account and no telemetry. It makes no network requests and no model calls: nothing it reads or decides leaves your machine through Cordon.

## What it reads

What the harness hands its hooks: your messages to the agent, the arguments of each tool call, the results the tools return, and the text of the agent's answer. Any of these can contain personal data (names, email addresses, file contents), because they are whatever you and your tools put in them.

## What it stores, where, and for how long

Everything is written under Cordon's home directory, `~/.cordon` (or `CORDON_HOME`), except the decision journal, which goes wherever your policy's `notify.file` points; the policies `cordon init` writes put it at `~/.cordon/events.jsonl`.

| What | Where | How long it lives |
|---|---|---|
| Your policy | `~/.cordon/policy.yaml` | until you delete it |
| Decision journal, only when `notify.file` is set: the tool, the decision, its reason and the source it names | the path in `notify.file` | until you delete it; moved to `<file>.1` at 50 MB, replacing the previous one |
| Session state: hashes and fragments of what was read and where it came from, and the links, names and words of your own messages that exempt a call | `~/.cordon/sessions/` | a day after the session's last event |
| Text of the answer being displayed | `~/.cordon/drafts/` | an hour after the last delta |
| One-time approvals: the tool and the refusal's reason | `~/.cordon/approvals/` | void after an hour, swept after that |
| Memory files written after untrusted content was read: path, source label, time | `~/.cordon/memory/` | thirty days, or until you trust it |

Expired files are deleted automatically on your next message, at most once an hour. Deleting `~/.cordon` removes everything Cordon has kept.

## What it shares

Nothing. Cordon sends no data to its author, to Anthropic or to anyone else. What it prints goes back to the harness on your machine, as the harness's hook protocol requires.

## Contact

Questions and reports: [github.com/ilyautov/cordon/issues](https://github.com/ilyautov/cordon/issues), or ilyautov@gmail.com.
