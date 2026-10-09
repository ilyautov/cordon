# Installing Cordon in Claude Code

Cordon installs as a plugin. The plugin binds one executable file to four harness events: the user's message, a tool call, a tool result, the display of the model's answer. There is no security logic in the plugin; it translates events into the core's contract and prints the decision.

Node 22 or newer is required. No keys, tokens or network access are needed: there are no network requests and no model calls in the hot path, by construction.

## Installation

```
/plugin marketplace add ilyautov/cordon
/plugin install cordon@cordon
```

There is no build step. The bundled file `plugin/dist/cli.js` ships in the repository ready to run, because an installed plugin has neither `node_modules` nor `package.json` next to it, and a file with external imports would crash `node` on the very first event. The harness reads a crashed hook as "pass", so the defence would switch off silently.

From a local clone:

```bash
git clone https://github.com/ilyautov/cordon.git
cd cordon
npm ci && npm run build
```

```
/plugin marketplace add /absolute/path/to/cordon
/plugin install cordon@cordon
```

## Checking that the hook is in place

The list of installed hooks is shown by `/hooks` in Claude Code. It answers the question "is it registered", not the question "does it work".

The second question is answered by `cordon doctor`. It reads the effective policy, runs a built-in attack sample through the whole path, and names the dangerous parts of the configuration.

The path to an installed plugin contains the marketplace name and the version, so it changes on every update. Do not hard-code it in scripts; ask the harness instead:

```bash
CORDON=$(node -e "
  const p = require(process.env.HOME + '/.claude/plugins/installed_plugins.json')
  const key = Object.keys(p.plugins).find(k => k.startsWith('cordon@'))
  if (!key) { console.error('plugin is not installed'); process.exit(1) }
  console.log(p.plugins[key][0].installPath + '/dist/cli.js')
")

node "$CORDON" doctor
```

The value comes out looking like `~/.claude/plugins/cache/<marketplace>/cordon/<version>/dist/cli.js`.

```
home directory: /Users/name/.cordon
policy: /Users/name/.cordon/policy.yaml
presence mode: autonomous
effect classes: read, summarize, create
source-influence footer: on
self-check: ok
note: doctor checks the mechanism, not the wiring. Whether the harness actually calls the hook is shown by /hooks in Claude Code and by /hooks panel in Gemini CLI
warning: argument quarantine in autonomous mode rests on updatedInput being applied without a permissionDecision: measured on Claude Code 2.1.236 that it is, not measured on Gemini CLI. Where it is ignored, quarantine does not fire and the control axis keeps working
```

The line `self-check: ok` means that the hidden layer is stripped, a call outside the certificate is refused, and a call inside the certificate goes through. It does not mean that the harness calls the hook: those are different questions, and the second one is answered by `/hooks`. A hook that is never called is indistinguishable from the outside from a hook that had no reason to fire. All checks run in a temporary home directory with their own policy, so `doctor` does not change the state of live sessions and does not depend on whether the user's profile is wide or narrow. The exit code is non-zero only when `self-check: broken`; warnings do not change it, because a warning is a question about configuration, not about whether the thing works.

A separate run in exactly the way the harness will call the hook, with an event on stdin:

```bash
echo '{"session_id":"check","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"'"$HOME"'/.cordon/policy.yaml","content":"mode: off"}}' \
  | node "$CORDON" hook
```

Expected answer: a refusal mentioning self-protection.

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"self-protection: /Users/name/.cordon/policy.yaml belongs to Cordon or to the harness"}}
```

The path to the installed plugin is shown by `/plugin`; it differs between installs. Empty output or a `node` error means there is no defence, and that is exactly the case where the absence of firings is indistinguishable from a working Cordon.

## What Cordon keeps on disk

Every hook event is a separate process, so memory between them lives as files in Cordon's home directory.

| What | Where | How long it lives |
|---|---|---|
| Policy | `~/.cordon/policy.yaml` | until you delete it |
| Decision journal | the path from `notify.file` | until you delete it |
| Session state: provenance of what was read, certificate narrowing, the links, names and words of your own messages that exempt a call | `~/.cordon/sessions/` | a day after the session's last event |
| Accumulated text of the displayed answer | `~/.cordon/drafts/` | an hour after the last delta |
| One-time approvals on the MCP gateway and in LangChain: the tool and the refusal's reason | `~/.cordon/approvals/` | void after an hour, swept after that |
| Timestamp of the last sweep | `~/.cordon/last-sweep` | overwritten |
| Memory written after untrusted content was read: path, source label, time | `~/.cordon/memory/` | thirty days after the write, or until `cordon: trust memory` |

Session state and drafts hold content that came from untrusted sources: hashes of what was read, source labels, fragments of answer text. There is no reason for it to sit there indefinitely, so expired files are deleted automatically.

There is no separate sweeper process: the sweep runs opportunistically, on the user's message, and no more than once an hour. The `PreToolUse` hot path pays nothing for it — it never walks the directory at all. The sweep deletes only files Cordon wrote itself, does not follow symbolic links, and never touches files of the session in progress, at any age. A failed sweep breaks nothing and stays silent: it is not part of the defence.

The lifetimes are constants in `src/session/sweep.ts` and are deliberately not configurable: state lifetime is not a matter of taste but a trade-off between hygiene and the fact that erased state means empty provenance.

## Policy

The policy is read from one place: `~/.cordon/policy.yaml`. The `CORDON_HOME` variable moves Cordon's home directory as a whole.

The project's working directory takes no part in this and never will. The same goes for a home inside the project: Claude Code hands a project's `env` setting to hook processes (verified on 2.1.282), so a repository could otherwise point `CORDON_HOME` at a policy of its own. A hook or gateway whose home resolves inside the project directory refuses, and says why. A session started in your home directory itself is exempt. A poisoned repository bringing its own config with the defence turned off would disable Cordon before it ever fired.

Without a policy file the default applies: `autonomous` mode, a profile of two classes, `read` and `summarize`, and no declared tools. Such an agent can read and summarize, and nothing else. The default is meant to be uselessly safe; widening it is a deliberate act.

`cordon init --profile <name>` writes a commented starting policy into Cordon's home. It never overwrites an existing one without `--force`.

| Profile | Mode | Effect classes |
|---|---|---|
| `locked` | autonomous | read, summarize (the default, written out) |
| `research` | interactive | read, summarize, network-egress |
| `documents` | interactive | read, summarize, create, update |
| `coding` | interactive | read, summarize, create, update, exec, network-egress |
| `service` | autonomous | read, summarize, create, network-egress, with budgets of 20 network-egress and 50 create calls per hour |

No profile grants `delete`, `export` or `financial`, because those are irreversible and adding them is your decision to write down. The widened profiles for a person at a terminal are interactive: under the exposure rule, autonomous mode refuses what interactive mode asks you about. `service` is for an agent nobody watches, a LangChain service or a scheduled bot: doubt is a refusal, the task and destinations are written into the file in advance, and budgets cap what it can do however it was steered.

`budgets` is a list of `{effect, limit, per}` with `per` one of `minute`, `hour`, `day`: at most `limit` calls of that effect go through in any sliding window of that length. The count is kept per effect and window, shared by every session, every process and both harnesses, so an agent that restarts itself or switches between a built-in and an MCP tool does not get a fresh budget; changing the policy keeps the counts and applies the new limit at once. It is kept as one file per call, so processes racing each other can only over-count. A call that may run spends: one allowed or rewritten, one put to you in the harness, and one that runs on `cordon approve`. A call refused by one budget takes back what it reserved in the others. A budget counts calls by their effect class, so a tool no policy classifies matches none; such a call is escalated rather than allowed, and a question you answer yes to in the harness then runs uncounted. Past the limit a call is refused with the rule `budget`, in either mode, no question is asked, and no approval lifts it. A count that cannot be read refuses the call too. Two budgets on the same effect and window stop the load. A LangChain service that loads its policy from a file can pass `policyFile` to the middleware, and it then stops acting when that file changes, as `cordon mcp` does.

`cordon policy explain [file]` reads a policy back in plain words, the one in force by default, with the defaults merged in. It says what each field does and what it does not: `destinations` count as named by you after an untrusted read and do not confine where the agent sends before one, `tools` classifies a tool and allows nothing the effects do not grant, and an empty list of paths or hosts bounds nothing. `cordon policy check [file]` validates a file by the loader's own rules and lints it: a destination that matches a whole domain zone or every mailbox at a public provider, the exposure rule switched off, trusted sources, unpinned MCP tools, the shell in autonomous mode, and an autonomous policy with no journal are warnings, and any warning fails the check. Irreversible effects and an unbounded network are notes. Use both on a mandate a model drafted for you: Cordon never calls a model, so the drafting happens outside it, and the reading back happens here, in code.

`cordon policy apply <file>` installs a checked policy as the one in force: it refuses a file the loader refuses, refuses one with warnings unless you pass `--accept-warnings`, prints the explanation, and replaces `policy.yaml` in one rename, installing exactly the bytes it checked. The journal records `policy-applied` before the rename, in the old policy's journal and the new one's, with the hash of the new policy, the hash of the one it replaced, where the journal goes next, and the OS user who ran it; if a journal cannot take the line, nothing is applied. A running `cordon mcp` gateway refuses every call after the policy changes, until it is restarted. The gate refuses this command, like `cordon approve` and `cordon init`, from the agent's own shell.

### Fields

**`mode`**: `interactive` or `autonomous`. See the section on modes below.

**`profile.effects`**: the effect classes the agent is allowed to produce. Nine are known: `read`, `summarize`, `create`, `update`, `delete`, `export`, `network-egress`, `financial`, `exec`. An unknown name is a load error, not something skipped.

**`profile.resources.paths`** and **`profile.resources.hosts`**: resource boundaries. An empty list means the boundary is not declared and is not checked. A non-empty list constrains: any argument that looks like a path or a link must fall inside it. A subdomain of a declared host is not covered by the boundary; allowing subdomains is written out explicitly.

**`tools`**: effect classes for tools the core does not know about. Claude Code's built-in tools are classified internally; MCP tools must be declared here. The reason is that a tool's description comes from the MCP server, which makes it untrusted text, and classifying by it is not possible. An undeclared tool is treated as unclassified and escalates.

**`trustedSources`**: prefixes of sources declared trusted by an explicit decision. An empty string in the list grants no trust: a YAML entry without a value is a typo, not "trust everything".

**`toolsReturn`**: what a tool returns — `source` or `rendered`. See the separate section below: whether the hidden layer is stripped from a result depends on this.

**`notify.file`**: path to the event journal. It must be absolute or start with `~/`. A relative path stops the load, because it would resolve against whatever project the agent runs in. See the section on the journal.

**`exposure`**: `true` or `false`, default `true`. While it is on, a session that read untrusted content is marked, and a call acting beyond reading — anything from the irreversible classes, plus `create` — escalates while the mark stands, unless the user named the call's destination in their own message: a link, a path, an identifier, or a name (a capitalized word, such as Alice, or a single quoted word, such as 'general'). A name counts only in a destination field (see `arguments`), and never for a call that executes something: "thank Alice" does not make `curl … # Alice` the user's own command. This is the rule that answers the attacks whose arguments share no byte with what was read: a paraphrase, an encoding, a clean shell command. The measured difference on the adversarial battery's working profile is a drop from 58% attack success (19 of 33) without the rule to 6% (2 of 35) with it; see [adversarial-report.md](adversarial-report.md). The price is friction: in autonomous mode, after any untrusted read a consequential call is refused until the user's next message names its destination. `false` restores the previous behaviour and weakens no other axis, and `cordon doctor` names the off state out loud with its price — from the outside it is indistinguishable from a session that simply read nothing untrusted.

**`memory.files`** and **`memory.tools`**: memory the agent reloads in later sessions, beyond what Cordon knows by name. `files` are base names compared case-folded (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules` and `copilot-instructions.md` are known already); `tools` are tool names as the harness calls them (`save_memory`, `create_memory` and `update_memory` are known already). Every file under `.cursor/rules/`, `.windsurf/rules/`, `.clinerules/` and `.github/instructions/` is memory whatever its name. A Mem0 store behind a tool is declared here. See the section on memory below.

```yaml
memory:
  files: [TEAM-RULES.md]
  tools: [mem0_add]
```

**`arguments`**: the role of a tool's arguments, by tool and argument name: `destination` (who receives the call: a recipient, a channel), `resource` (what the call reaches: a repository) or `content` (what it carries). Only a destination field can carry a name that exempts a call from the exposure rule, and a resource field is what the resource rule reads. Undeclared arguments get a role from their name: `to`, `recipient`, `channel`, `email`, `user` and similar are destinations, and so are paths and file names, the place a write lands; `repo`, `repository`, `owner`, `org`, `organization` and `namespace` are resources; everything else is content.

```yaml
arguments:
  mcp__crm__notify: {account: destination, note: content}
  mcp__github__get_file_contents: {project: resource}
```

A fourth role, `controlled`, is only ever declared. It is for a field that changes something the target does not say, such as an amount, a date or a status. The exposure rule answers where a call goes. A lookup can vouch for the right payment while a page talks the agent into the wrong amount on it. Under the exposure mark, a controlled field must hold a value the user assigned to it in their current message, whatever named the target. Such an assignment is three things in a row:

- **The field's name**, with its underscores written as spaces or not, in any case.
- **One connector:** `=`, `:`, `→`, `to`, `is`, `at` or `equals`.
- **The value**, in one of two forms:
  - **Bare.** Only a number, a date or a time, written whole: `amount to 1,200.50`, `date: 2026-10-01`, `start at 10:00`. The thousands separators in the `1,200.50` form are dropped. Any other form assigns nothing: `1.200,50`, `1e3` and a number split by a space are not read.
  - **Quoted.** Anything else: `status to 'Approved'`, `new_start_time to '2024-05-20 10:00'`.

The rule is syntax, not meaning:

- A number elsewhere in the message assigns nothing, so "don't pay 99000" and "the amount 99000 was disputed" state no amount.
- A question does assign: "did you set amount = 1200?" does.
- Words inside another quoted value assign nothing.

A number in the call must be exactly the number written: `1,200.50` matches 1200.5, and nothing is rounded. The field is found by its folded name at any depth, so `Amount` is `amount`. A field left out of the call passes. A null, a list or an object in it does not. Without the mark nothing changes.

```yaml
arguments:
  mcp__bank__update_scheduled_transaction: {id: destination, amount: controlled, date: controlled}
```

**`destinations`**: the task's mandate, for an agent that runs without a human to name things. A value listed here counts as named by the user under the exposure mark, in a destination or a resource field, and never for a call that executes something. An entry is an exact value, or `*` followed by a suffix (`*@example.com`, `*.example.com`). An entry that is only `*` is a load error: a mandate that names everything names nothing.

```yaml
destinations: [ops@example.com, '#deploys', acme/website]
```

**`lookups`**: tools whose records bind a name to a value, such as a contact's name to their address or a file's name to its id. After an untrusted read, the address the contact search returned for "Sarah Baker" is a destination the user never typed. A lookup declared here makes it count as named, but only in the arguments listed for it, and only when all of the following hold:

- the record's name is a whole name the user said in their last message: a run of two to four capitalized words like Sarah Baker, a quoted phrase with a capitalized word in it, or an atom. A name from an earlier message does not count;
- the lookup was asked with words from that same message;
- no record seen in the same turn binds that name to a different value, or to no value. Records from a lookup asked with no query count here, though they never vouch;
- the lookup ran in the current turn, after the user's last message;
- every lookup result of the turn could be read whole. One that could not, because it is not YAML or JSON, is over 256 KB, repeats a key in a record, uses an alias or a tag, or has a null or composite key, voids every binding of the turn: it could have held the second record for a name.

Only the declared fields are read. The rest of the result, a file's content or an event's description, stays untrusted as before. A value counts only in the declared argument itself or as an element of its list, never in an object nested inside the call. A list, such as a meeting's participants, is checked element by element, so one extra participant is refused.

A name is compared case-folded; a value is compared exactly as written, since `AbCd` and `abcd` can be two different files. Conflicts are counted per lookup tool: two declared tools that bind one name to different values do not see each other, which is why the records of every declared lookup should come from your own system.

On Gemini CLI an MCP lookup is declared under `server/tool`, the same key as its view in `toolsReturn`, so a same-named tool on another server records nothing. Its consumers keep the bare tool name, `create_event.participants`, because that is the name Gemini gives the gate. The MCP gateway has no user turns, so the task text counts as the message, and one unreadable result voids the bindings for the rest of the run.

```yaml
lookups:
  mcp__crm__search_contacts:
    query: query          # the argument the lookup is asked with
    key: name             # the field that names each record
    values:
      email: [mcp__mail__send.to, mcp__calendar__create_event.participants]
  mcp__drive__search_files_by_name:
    query: filename
    key: filename
    values:
      id: [mcp__drive__append_to_file.file_id]   # an append, and not a delete
```

What remains is a record that is the only one under the user's name and was written by the attacker, for example a calendar invite titled like the user's meeting, when the real meeting is not in the results. Declare a lookup only when the records it returns are written by your own system: an address book is a good candidate, a calendar that anyone can send invites to is a weaker one.

**`mcp.pin`**: `true` or `false`, default `true`. When it is on, the MCP gateway pins each server's tools the first time it sees them, then hides and refuses any tool that changed or appeared since. See [install-mcp.md](install-mcp.md#tool-pinning).

A key the loader does not know stops the load, whether at the top level or inside `profile`, `notify`, `memory`, `mcp` or `output`. Every field has a default, so a misspelled key used to fall silently to that default. `exposur: false` would have left the rule on, and nothing would have shown it.

### Example: interactive work on code

```yaml
mode: interactive
profile:
  effects: [read, summarize, create, update]
  resources:
    paths:
      - /Users/name/projects/my-project
tools:
  mcp__github__create_issue: [create, network-egress]
  mcp__github__list_issues: [read, network-egress]
notify:
  file: /Users/name/.cordon/events.jsonl
```

The classes `exec`, `delete` and `financial` are deliberately absent here. `Bash` belongs to the `exec` class as a whole: parsing the command means a shell parser, and every shell parser can be worked around. If a task needs `Bash`, then `exec` is added to the profile deliberately, with the understanding that the hook does not see the contents of the command.

**`blockedTools`** is an optional list of exact tool names as the hook receives them. A listed call is denied before effect classification, in either mode; `cordon approve` cannot release it. For Codex CLI, a restricted-runner policy can grant `exec` while refusing its native shell and file editor:

```yaml
profile:
  effects: [read, summarize, exec]
tools:
  mcp__sandbox__run: [exec]
  run: [exec]
blockedTools: [Bash, apply_patch]
```

With the MCP server named `sandbox`, the hook sees the runner as `mcp__sandbox__run`; the Cordon MCP gateway sees the upstream tool as `run`, so both names are declared when both boundaries are installed. The example omits `create` and `update` and explicitly blocks Codex's `apply_patch`. A live Codex control with those effects granted and only `Bash` blocked wrote a file through native `apply_patch`, outside the runner; removing the effects or blocking that tool stopped the write ([paired run](model-origin-benchmark.md#active-native-shell-hook-and-connected-runner-in-one-configuration)). Use the actual names of every direct execution and host-editing tool in the harness. A block on `Bash` does not block a differently named shell tool, a subprocess inside an allowed tool, or calls that never reach Cordon's hook. The declared runner still needs operating-system file and network limits; Cordon does not inspect a command's later effects.

### Example: a scheduled overnight job

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
  file: /Users/name/.cordon/events.jsonl
```

The `toolsReturn` line here is not decoration. The seller sees a review rendered on the marketplace storefront: a block with `display:none` never reaches their eyes. Without the declaration, Cordon treats an MCP tool result as source and does not strip the hidden layer — it will reach the model, and the seller will learn about it from the transcript and the journal. See the `toolsReturn` section below.

The profile matches the task "answer reviews": read, and write an answer. Changing a price is `update` and `financial`; neither is in the profile, so an instruction hidden in a review ends at the control axis regardless of how convincing it is.

The `wb_update_price` tool is declared even though it is not meant to be used. The declaration exists exactly for that: an undeclared tool would also be blocked, but with the wording "not declared in the policy", whereas a declared one gives the journal an honest reason, "outside the certificate: update, financial".

### A credential leaving the machine

A call that carries a credential escalates, read or no read, unless all it does is write locally (`create`, `update`, `delete`): a refusal in autonomous mode, a question in interactive mode. A tool declared as a `read` counts, since an MCP search tool sends its query to the server. Property names are checked along with values. A credential is recognized by shape: GitHub, Anthropic, OpenAI, AWS, Slack, Google, GitLab and Stripe credentials, and private keys, by the header together with the first line of the key, so a grep for the header is not one. The reason names the kind and never the value, so the key goes neither into the journal nor back to the model. Writing it to a local file is not this rule. A credential you paste into your own message is exempt, since you named it; that key and no other. The key AWS prints in its documentation, ending in `EXAMPLE`, is not a credential. This covers the careless case, an agent putting a token into a curl command on its own; the injected case is the exposure rule's.

What the shape check does not see: a credential passed by reference (`$GITHUB_TOKEN` in a command), a credential written to a file and sent in a later call, and credentials without a fixed prefix, such as JWTs and passwords inside connection strings. After an untrusted read, the exposure rule escalates both calls in the first two cases. Without one, only the literal is caught.

### A resource you did not name

After an untrusted read, a call that reaches a resource the user never mentioned escalates, even a read. This is the GitHub MCP "toxic agent flow": an issue in a public repository asks the agent to read the owner's private repository and post what it found. The call reads, so no effect class stops it; the repository name comes from the page, but the page can spell it as the user would. The rule reads fields with the `resource` role and passes a value the user said in their own words, as a whole or segment by segment (`acme` and `website` said, `acme/website` passes), or one listed under `destinations`.

### Agent configuration written after an untrusted read

After an untrusted read, a write to a file that configures an agent escalates: `.vscode/settings.json`, `.vscode/tasks.json`, `.vscode/mcp.json`, `.vscode/launch.json`, `.mcp.json`, `.windsurf/mcp.json`, `.continue/config.json`, `.zed/settings.json`, `.zed/tasks.json` and `.devcontainer/devcontainer.json`, by a file tool or by a shell command that names the file. An injected write there turns confirmations off or adds an MCP server that runs a command on the next start (CVE-2025-53773, CVE-2025-54135). The harness directories `.claude`, `.cursor`, `.codex`, `.gemini`, `.kimi-code`, `.kimi` and `.dsh` are not writable at all; see self-protection.

### Autonomous agents: declare what is a directory

With `mode: autonomous` and nothing else declared, every tool result is untrusted, and after the first read the agent can act only on destinations the user named. On AgentDojo that left an obedient scripted agent 3 of 21 Slack tasks ([agentdojo.md](agentdojo.md)). Most of the refusals were not about injected text at all: `External_0` read from the channel list counted as a destination the page chose.

Some tools return the system's own records rather than text somebody wrote: a balance, a price list, a user directory. Declare those trusted, by tool name:

```yaml
trustedSources:
  - mcp__slack__get_users_in_channel
  - mcp__bank__get_balance
```

Be strict about what goes on the list. A tool qualifies when every field it returns is written by your system, not by a person outside it. Message bodies, emails, documents, reviews, calendar descriptions and web pages never qualify, even from your own systems: that is where injections live. Names do not qualify either when outsiders choose them. A channel list looks like system data, but anyone who can create a channel writes its name, and AgentDojo puts an injection in one: with `get_channels` on this list, an obedient agent was carried into 15 of 105 attacks. A trusted result sets no exposure mark and taints nothing, so a wrong entry here is a hole, not friction.

If the agent can wait for a human, `mode: interactive` is the larger lever: the same refusals become questions. On the same benchmark, the scripted agent completed every Slack task with 1.6 questions per task on average.

## What a tool returns: source or rendered

Cordon strips from a result whatever is hidden **from the human**: a block with `display:none`, a comment, `<style>`, `<script>`. That hiddenness depends on how the human sees this particular text.

A web page they see rendered — the hidden block never reaches their eyes, and stripping it is honest. A file they open in an editor and see as source in full — nothing is hidden from them there, and stripping would destroy the file's content as soon as the agent writes it back. For the built-in `Read`, `Grep`, `Glob` and `Bash`, Cordon knows the answer itself.

For an MCP tool it does not know the answer and cannot. The tool name is chosen by the MCP server, and `read_file` from someone else's server may be anything at all, while `search` may read files from disk. Trusting the name is impossible for exactly the same reason that effect classes for MCP tools are also written by hand.

The person who connected the server knows the answer. They are the one who writes it down:

```yaml
toolsReturn:
  # The server reads files: their content must not be touched, otherwise the
  # agent will write the file back without its markup and scripts.
  mcp__filesystem__read_file: source
  # The server brings web pages and storefront reviews: the human sees them
  # rendered, so the hidden layer is stripped from them.
  mcp__browser__open_page: rendered
  wb_reviews: rendered
```

The key is the tool name exactly as the harness calls it. In Claude Code an MCP tool name already contains the server name: `mcp__server__tool`. In Gemini CLI the server name arrives separately, so the key is written with a slash: `server/tool` (for built-ins, simply `read_file`, `web_fetch`). The separation is mandatory: otherwise a declaration written about built-in reading would silently spread to a third-party server that named its tool the same way.

**Default: an MCP tool result is treated as source.** That is, without a declaration the hidden layer is NOT stripped from it: it reaches the model, while the finding is named to the human in the transcript and written to the journal with a `notice` mark.

The default leans towards data integrity. The opposite would mean that an MCP server that reads files corrupts them always — not under attack, but during ordinary reading of ordinary markup — silently and irreversibly. Letting a hidden layer through requires an attacker, is audible to the human, and runs into the two remaining axes: the certificate limits effect classes, provenance remembers what was read. Writing a corrupted file back runs into nothing.

Hence the working rule: **declare any MCP tool that brings text from the outside world as `rendered`.** One line per tool. `cordon doctor` shows the effective default and all your declarations:

```
MCP tool result without a declaration: source, hidden layer is not stripped ...
toolsReturn declarations: mcp__filesystem__read_file: source; wb_reviews: rendered
```

A declaration applies to built-in tools too, and that is rarely needed. `Read: rendered` brings back the bug where editing a file that had been read destroyed its markup and scripts, so `doctor` warns about such a declaration separately.

A typo in the value is a load error, not a silent default: `toolsReturn: {wb_reviews: sourse}` will not start at all. A policy that does not do what it says is more dangerous here than a refusal.

## Presence modes

The mode is an explicit setting, not a guess from circumstances. A tool that asks the agent itself for permission in autonomous mode is decoration.

| What happened | `interactive` | `autonomous` |
|---|---|---|
| effect class outside the certificate | `ask` | `deny` and a journal entry |
| class inside the certificate, arguments tainted | argument quarantine, `ask` if impossible | quarantine, `deny` and a journal entry if impossible |
| class inside the certificate, arguments clean | pass | pass |

**A pass is silence, not permission.** Cordon never prints `permissionDecision: "allow"`. An explicit allow from a hook overrides the user's own permission settings, which would mean Cordon started handing out rights instead of limiting them.

**Argument quarantine** cuts out the tainted part and lets the call through with the rest. In interactive mode the quarantine is printed together with `ask`, so the modified input is shown to the human. In autonomous mode there is nobody to ask, and the edit goes through silently. A call that leaves the machine (`network-egress`, `export`, `financial`) is never cut: a message or a payment memo with a hole in it reaches a stranger while the model reports it sent whole, and a sent message cannot be mended. Such a call escalates instead, with the draft whole: a question in interactive mode, a refusal in autonomous mode. A write into memory is treated the same way.

## Narrowing rights for a single turn

The line `cordon: scope read` in the user's message narrows the certificate to the listed classes for the current turn. The directive is read only from the user's message: the same line in a review, an email or a file has no effect, because a directive inside untrusted text is precisely the attack.

The narrowing survives the process boundary and is lifted by the next user message. The directive cannot widen the set of classes: the intersection with the profile is applied, so it cannot restore a right the policy does not grant.

A typo in a class name yields an empty set, that is, "nothing is allowed", plus a warning. A typo cannot silently widen rights.

## Memory that outlives the session

The exposure mark lives until the user's next message, and session state lives a day. Neither survives to the session where a poisoned note in `CLAUDE.md` acts — a session that reads nothing untrusted and so has no mark of its own. The memory ledger is the one piece of state that deliberately outlives a session, for exactly that reason.

A write into memory is recorded when the session making it carries untrusted content: the exposure mark, the unredacted mark, a full provenance store, a quarantine rewrite of the call itself, or a page or tool result from outside read in any earlier turn of the session. It is recorded on `allow`, on a rewrite and on `ask` — the hook never learns whether the human said yes, and a declined write recorded costs one question later, while a missed one costs the attack. A `deny` is never recorded: the write did not happen.

While the ledger holds a live entry, every new session starts under the exposure mark: a call acting beyond reading escalates unless the user named its destination. A new user message does not lift this mark, because the harness reloads the file into every turn. The refusal names the file and the source.

To lift it, read the file, fix it if needed, and write on a line of its own in a message:

```
cordon: trust memory
```

The directive is read only from the user's message. The memory file comes into the context through the harness, never through this parser, so a note cannot vouch for itself by containing the phrase. `cordon doctor` lists the live entries. `exposure: false` in the policy switches the ledger off along with the rule it extends.

## Event journal

`notify.file` enables line-delimited JSON logging. One line per decision:

```json
{"at":"2026-08-19T02:14:07.201Z","decision":"deny","tool":"wb_update_price","reason":"outside the certificate: update, financial","source":null}
```

**The `source` field names the untrusted source the decision answers to.** When the gate knows it, it is exact: the page an argument's target came from for a provenance refusal or a quarantine rewrite, the read that set the mark for an exposure refusal, the page a memory note was written after for a `memory` line. When the decision did not turn on anything read — a tool outside the certificate — it falls back to the last untrusted page or tool result of the session, as the likeliest author of the attempt, and to `null` when nothing untrusted was read. MCP tool descriptions never fill it by that fallback: they are read in one batch per session, and the last of them is an arbitrary name.

`cordon log` reads the journal back: one event per line with its rule and source, a count by decision at the end, and the classes of the refused calls grouped by tier (see [enterprise.md](enterprise.md#audit-logs) for the codes). `--last N` keeps the newest N events, and `--json` prints them as an array. Source labels are text an attacker wrote, so control characters in them are printed as escapes: a URL cannot clear or retitle the terminal of the person reading the log. A line that does not parse is counted aloud instead of skipped. Without `notify.file` the command exits 1 and says so.

The journal is half of autonomous mode. A call blocked overnight that the owner never heard about is indistinguishable, for them, from a call that never happened.

The notification channel must be one the agent cannot reach. Telling the agent itself that the agent is blocked makes no sense. A file is the whole of it: there is no network anywhere in the core, so delivering to a webhook or a messenger belongs to whatever reads the file. `notify.webhook` in the policy is refused outright rather than ignored, because the field was once accepted while nothing was ever sent to it, and an owner who wrote it there believed they were being notified overnight and were not.

## The source-influence footer

A few lines appear under the model's answer — but only when the answer contains text that matches a previously read untrusted page verbatim.

```
Based on the comparison: CRM-X was named the best system of the year.

Cordon, source influence on this answer:
  - "https://crm-x.com/compare": matching spans: 1; only itself vouches for it
The absence of a note corroborates nothing: paraphrase is invisible here.
```

The footer can say four things and no more: which sources the answer matched verbatim and in how many spans; that only the subject itself vouches for it, that is, the matching text came from its own domain and names that same subject; that the source is a syndication outlet, where the text is written by the subject and published on someone else's domain; and that the sources are **not independent**, because their verbatim text coincides — at which point it also shows the shared fragment itself, so the human can tell a quotation from a law from coordinated praise in a second. The fragment's boundaries are approximate, which the footer says outright: the index stores window hashes rather than text, so the excerpt may pick up a word or two from the answer itself.

**The footer cannot say "corroborated", and this is not cautious phrasing.** The success rate of output manipulation rises from 39 to 77 percent as the number of **distinct** source domains grows from one to three (arXiv:2606.16821). That is, "many sources and different domains" means the opposite of reliability, and the word "corroborated" would produce exactly the confidence the attacker is after.

**The absence of a footer means nothing.** Matching is verbatim, in windows of 32 characters. Paraphrase produces no such windows and is entirely invisible here — that is the boundary of the method, not an unfinished feature. The footer's silence reads as "Cordon saw nothing".

**The footer does not enter the model's context.** The `MessageDisplay` event changes only what the human sees: the transcript and the model's context are left untouched. This is not a workaround but the only correct channel. A note that came back into the context would become an injection carrier on the next turn, and a conflict-of-interest disclosure handed to the model as text does not make it meaningfully lower its trust in the source anyway (arXiv:2606.05403) — it is a hint, not a defence.

**A failure on this event does not hide the answer.** This is the single place in all of Cordon where fail-closed would be wrong: any error ends in an empty response, and the harness then shows the model's original text. A refusal here would protect nothing — the event decides nothing — while costing the human the sight of the answer. The timeout is set to 5 seconds against the event's default of 10: the hot path is synchronous, and if it did not finish in time then it is broken, not slow.

### Links and images that would carry data out

After an untrusted read, the footer also names the addresses in the answer that would send something out when the answer is shown or opened: every image the user did not name, and every link not copied whole from what was read or from the user's message, unless the user named its host and it carries no data (no query, userinfo, or identifier in the path or the fragment). A host that only the page mentioned vouches for nothing: the page can name its own collector, and a composed host carries data by itself, as in `secret123.evil.example`. Addresses inside code blocks and code spans are left alone, since nothing there is fetched, and character references such as `https&#58;//` are decoded first, as a renderer does. An image in a viewer that renders markdown is fetched with no click, which is how EchoLeak (CVE-2025-32711) and the Slack AI and ChatGPT image leaks worked. An allowlist of image hosts is no answer: CamoLeak went through GitHub's own image proxy, one pre-signed address per character, so an image copied from the page counts too.

```
Cordon: this answer was written after an untrusted read and carries addresses that would send data out when shown or opened:
  - evil.example (image)
An image loads by itself in a viewer that renders markdown; do not open these links, and do not paste this answer into one.
```

The hook sees the answer on its way to the screen and cannot take back the parts already shown, so here it warns and does not cut. The terminal renders no images; the risk is a link opened by hand, or the answer pasted somewhere that renders it. The LangChain middleware holds the answer before anyone sees it and cuts instead; see [install-langchain.md](install-langchain.md). `exposure: false` turns this off together with the rule it belongs to, and so does `output.footer: false`.

### Turning the footer off

```yaml
output:
  footer: false
```

Only the footer is turned off. The control and data axes keep working: the footer decides nothing, it only describes. The switch exists precisely so that a person bothered by three lines under the answer does not delete the whole plugin together with the whole defence. `cordon doctor` shows the effective state on the `source-influence footer` line.

## Installation limits

**Cordon cannot be combined with another hook that rewrites the same input.** If several hooks return `updatedInput` on one event, the one that finished last is applied, and finishing order is non-deterministic. With two rewriting hooks the result therefore changes from run to run, and on some runs the call goes out with tainted arguments. This is a harness limitation, and there is nothing on Cordon's side to fix it with. Hooks that do not rewrite input coexist fine.

**A hook that times out does not block the call.** Timeouts are set short explicitly: 5 seconds for `UserPromptSubmit`, `PreToolUse` and `MessageDisplay`, 10 for `PostToolUse`. A long timeout here is not a safety margin but a window in which the defence is off. For the same reason the hot path is synchronous: no network, no waiting.

**Argument quarantine lands only on a call the harness was going to allow anyway.** In autonomous mode quarantine is printed as `updatedInput` with no permission decision, because there is nobody to ask and printing `allow` is not allowed. Claude Code 2.1.236 applies such a response — measured, see [live-run.md](live-run.md) — but only once the call has cleared the harness's own permissions: with the tool not pre-approved the write never happened at all and the quarantine never came into play. Cordon is not a second permission system and does not become one. On Gemini CLI this has not been measured; where the response is ignored, the call goes out with its original arguments and the control axis keeps working, quarantine being the second line rather than the first.

**A quarantined call is reported by the model as though nothing was cut.** The model composes the arguments, the harness applies the substituted ones, and nothing tells the model what changed — so its account of the turn describes what it wrote, not what landed. This is why every rewrite goes into the journal: the journal and the file are the only two places the difference is visible.

**Output of an unknown shape is not substituted.** The harness silently discards a substitution whose shape did not match the original and shows the model the original text. So Cordon does not touch an unfamiliar shape at all; it marks the session instead, and the next action more complex than reading escalates. The mark is lifted by a new user message.

## What Cordon does not do

It is more honest to name the boundaries of the stretch up front. What follows is the whole list, not a selection from it.

**It does not protect against a user jailbreaking their own model.** The victim and the attacker are the same person; that is the model vendor's job.

**It does not judge the truthfulness of visible text.** A callout saying "our product is the best" on a vendor's site stays untouched: it is indistinguishable from ordinary marketing, because that is what it is. Any detector that catches this catches everything else along with it.

**The output axis can only say "not corroborated".** It names the sources the answer matches **verbatim** and does not presume to judge paraphrase. Coordinated paraphrase across different domains passes it entirely, because telling a restated claim from the model's own conclusion requires a model, and the gate has none. Hence the rule: the absence of a footer means "Cordon saw nothing", not "checked, clean".

**An unclosed raw block on a real page stays in the text.** An opening `<script>` or `<style>` without a closing tag is treated as a mention of the tag rather than a block. Otherwise mentioning a tag name in technical documentation would swallow all the text below the mention and silently discard half of an honest document.

**A word written entirely in another script is not caught.** `сор.com` typed in Cyrillic instead of `cop.com` contains no script mixing: there is one script inside the word. A confusable table would fire on any honest Russian word made of letters with Latin twins, and the Russian word "сор" exists.

**A file that was read and shell output are not substituted.** Cordon removes what is hidden **from the human**, and hiddenness is defined by the way the human looks at the source. A web page they see rendered, and a comment inside it is hidden from them. A file they open in an editor and see in full, so `<style>`, `<script>` and comments from a file that was read are not stripped: otherwise the model would see a truncated file and the next `Write` would overwrite the original with it. The price is named: a poisoned local file — a cloned repository, a downloaded artifact — reaches the model with its hidden layer. The finding is still named out loud in the transcript and written to the journal, and both axes keep working: the certificate limits actions, provenance remembers what was read by its original text.

**The contents of a `Bash` command are not parsed.** The hook sees `Bash`, not the fact that the script inside writes files and reaches the network. Hence the separate `exec` class and the sandbox requirement in autonomous mode. Closing this fully happens at the operating-system kernel level.

**Verbatim transfer of untrusted text outward is allowed.** An agent may publish an injection in full in an answer to a review, from where the next agent will read it. The rule cannot be revoked: without it, summarizing what was read and quoting a document would also go to quarantine, meaning all meaningful work would stop. The chain breaks where Cordon stands, not where the text was published.

**The profile is written by a human, and a profile wider than necessary opens the attack.** The `financial` class in an "answer reviews" profile would make the marketplace scenario passable. This is a transfer of trust to the user, not an implementation defect, which is why the default is uselessly safe and the effective profile is shown in plain text.

## Uninstalling

```
/plugin uninstall cordon@cordon
```

The policy file and the journal stay in `~/.cordon`; the user deletes them by hand. Session state and drafts delete themselves, but only while Cordon is still being launched: after the plugin is removed there is nobody left to sweep them, so `~/.cordon/sessions` and `~/.cordon/drafts` are also removed by hand.
