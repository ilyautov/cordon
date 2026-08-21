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
| Session state: provenance of what was read, certificate narrowing | `~/.cordon/sessions/` | a day after the session's last event |
| Accumulated text of the displayed answer | `~/.cordon/drafts/` | an hour after the last delta |
| Timestamp of the last sweep | `~/.cordon/last-sweep` | overwritten |

Session state and drafts hold content that came from untrusted sources: hashes of what was read, source labels, fragments of answer text. There is no reason for it to sit there indefinitely, so expired files are deleted automatically.

There is no separate sweeper process: the sweep runs opportunistically, on the user's message, and no more than once an hour. The `PreToolUse` hot path pays nothing for it — it never walks the directory at all. The sweep deletes only files Cordon wrote itself, does not follow symbolic links, and never touches files of the session in progress, at any age. A failed sweep breaks nothing and stays silent: it is not part of the defence.

The lifetimes are constants in `src/session/sweep.ts` and are deliberately not configurable: state lifetime is not a matter of taste but a trade-off between hygiene and the fact that erased state means empty provenance.

## Policy

The policy is read from one place: `~/.cordon/policy.yaml`. The `CORDON_HOME` variable moves Cordon's home directory as a whole.

The project's working directory takes no part in this and never will. A poisoned repository bringing its own config with the defence turned off would disable Cordon before it ever fired.

Without a policy file the default applies: `autonomous` mode, a profile of two classes, `read` and `summarize`, and no declared tools. Such an agent can read and summarize, and nothing else. The default is meant to be uselessly safe; widening it is a deliberate act.

### Fields

**`mode`**: `interactive` or `autonomous`. See the section on modes below.

**`profile.effects`**: the effect classes the agent is allowed to produce. Nine are known: `read`, `summarize`, `create`, `update`, `delete`, `export`, `network-egress`, `financial`, `exec`. An unknown name is a load error, not something skipped.

**`profile.resources.paths`** and **`profile.resources.hosts`**: resource boundaries. An empty list means the boundary is not declared and is not checked. A non-empty list constrains: any argument that looks like a path or a link must fall inside it. A subdomain of a declared host is not covered by the boundary; allowing subdomains is written out explicitly.

**`tools`**: effect classes for tools the core does not know about. Claude Code's built-in tools are classified internally; MCP tools must be declared here. The reason is that a tool's description comes from the MCP server, which makes it untrusted text, and classifying by it is not possible. An undeclared tool is treated as unclassified and escalates.

**`trustedSources`**: prefixes of sources declared trusted by an explicit decision. An empty string in the list grants no trust: a YAML entry without a value is a typo, not "trust everything".

**`toolsReturn`**: what a tool returns — `source` or `rendered`. See the separate section below: whether the hidden layer is stripped from a result depends on this.

**`notify.file`**: path to the event journal. See the section on the journal.

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

**Argument quarantine** cuts out the tainted part and lets the call through with the rest. In interactive mode the quarantine is printed together with `ask`, so the modified input is shown to the human. In autonomous mode there is nobody to ask, and the edit goes through silently.

## Narrowing rights for a single turn

The line `cordon: scope read` in the user's message narrows the certificate to the listed classes for the current turn. The directive is read only from the user's message: the same line in a review, an email or a file has no effect, because a directive inside untrusted text is precisely the attack.

The narrowing survives the process boundary and is lifted by the next user message. The directive cannot widen the set of classes: the intersection with the profile is applied, so it cannot restore a right the policy does not grant.

A typo in a class name yields an empty set, that is, "nothing is allowed", plus a warning. A typo cannot silently widen rights.

## Event journal

`notify.file` enables line-delimited JSON logging. One line per decision:

```json
{"at":"2026-08-19T02:14:07.201Z","decision":"deny","tool":"wb_update_price","reason":"outside the certificate: update, financial","source":null}
```

**The `source` field is always empty today, and this is a known shortcoming.** The label of an untrusted source lives in process memory, and every hook event is a separate process, so it does not survive until the decision is recorded. The journal does not yet name who exactly poisoned the turn, though it does name the reason and the tool.

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
