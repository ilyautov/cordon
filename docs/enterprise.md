# Deploying Cordon across an organization

This page is for the administrator who puts Cordon on every developer's machine and needs it to stay there. It covers Claude Code; the MCP gateway is deployed through the host's own configuration ([install-mcp.md](install-mcp.md)).

Everything about Claude Code's managed settings below is taken from its documentation ([managed settings](https://code.claude.com/docs/en/managed-settings), [settings reference](https://code.claude.com/docs/en/settings-reference)). The deployment below was run on one machine, with the result recorded under [What was verified](#what-was-verified). Verify it on one of yours before a fleet rollout.

## Why managed settings, and not the plugin alone

A plugin a developer installs is a plugin a repository can turn off. The attack does not need the developer's cooperation. It needs the developer to open the repository and trust the folder:

- `disableAllHooks: true` in a project's `.claude/settings.json` silences every hook that is not managed, Cordon's included.
- `enabledPlugins: {"cordon@cordon": false}` in the same file outranks the user's own enabling.
- `env` in the same file reaches hook processes, verified on Claude Code 2.1.282. Cordon refuses a `CORDON_HOME` inside the project for this reason, but `NODE_OPTIONS` or `PATH` put the project's own code into the hook process.

`cordon audit` names each of these (CA303, CA304). Managed settings remove them: nothing a user, project or `--settings` sets overrides them, and **only managed settings can disable managed hooks**.

## The deployment

### 1. Install a pinned Cordon on every machine

```bash
npm install -g @ilyautov/cordon@0.7.0
npm audit signatures        # the release carries an npm provenance attestation
```

Use whatever your fleet uses for packages. What matters is a fixed version at a fixed path that users cannot write to. The examples below assume `/usr/local/lib/node_modules/@ilyautov/cordon/dist/cli.js`. Check the path with `npm root -g`.

### 2. Write the managed settings file

| OS | Path |
|---|---|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux and WSL | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

If several teams own parts of the policy, a `managed-settings.d/` directory next to the file takes one JSON file per part. Server-managed settings from the claude.ai admin console and MDM profiles are the other delivery paths. The linked page ranks them.

```json
{
  "allowManagedHooksOnly": true,
  "env": {
    "CORDON_HOME": "~/.cordon",
    "NODE_OPTIONS": "",
    "NODE_PATH": ""
  },
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/node /usr/local/lib/node_modules/@ilyautov/cordon/dist/cli.js hook", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/local/bin/node /usr/local/lib/node_modules/@ilyautov/cordon/dist/cli.js hook", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/local/bin/node /usr/local/lib/node_modules/@ilyautov/cordon/dist/cli.js hook", "timeout": 10 }] }
    ]
  }
}
```

- **`allowManagedHooksOnly: true`** runs only managed hooks, Agent SDK hooks and hooks from plugins that managed settings force-enable. User, project and local hooks are blocked, and so are hooks from other plugins and hooks in agent frontmatter. This is a lock: the strictest value any admin source sets applies. Note that `/goal` cannot run while it is set, because `/goal` depends on hooks.
- **The hooks live in managed settings themselves**, not in a force-enabled plugin. Only managed settings can disable managed hooks, so a project's `disableAllHooks` cannot reach them.
- **`env` pins what a project could otherwise set.** Managed `env` merges per variable and wins over the same variable from any project. `CORDON_HOME: "~/.cordon"` is the default value, pinned: Cordon expands the leading tilde for each user, and a project can no longer point the home at a policy it planted. The directory must be writable by the developer, because session state lives there. Emptying `NODE_OPTIONS` and `NODE_PATH` stops a project from loading its own code into the hook process.
- **`node` by absolute path**, because `PATH` is the one variable you cannot pin to a single value for every machine. Use the path your fleet installs Node at (`which node`).
- **The fourth event**, `MessageDisplay`, draws the source-influence footer. Copy it from [`plugin/hooks/hooks.json`](../plugin/hooks/hooks.json) if you want the footer. It decides nothing.

If you would rather distribute the plugin through an internal marketplace, force-enable `cordon@<your-marketplace>` in managed `enabledPlugins` and register the marketplace in `extraKnownMarketplaces`. Under `allowManagedHooksOnly` Claude Code matches the full `plugin@marketplace` ID, so a same-named plugin from elsewhere stays blocked. Hooks from a force-enabled plugin are not managed hooks, though, so the direct `hooks` block above is the stronger form.

### 3. Deploy the policy

The policy is `policy.yaml` in Cordon's home ([install.md](install.md#fields)). A key the loader does not know stops the load, so a typo cannot silently weaken what you shipped. Check a policy before distributing it:

```bash
CORDON_HOME=/path/to/staging cordon doctor
```

`doctor` prints the effective mode, effect classes, exposure rule, memory ledger and MCP pinning state, and exits non-zero on a broken installation. A broken policy is a refusal on every hook event, never a silent default.

### 4. Verify on one machine, then roll out

1. Run `/status` inside Claude Code. The `Setting sources` line should show `Enterprise managed settings (file)`, or the source you used.
2. Run `claude doctor`. It lists entries Claude Code dropped from managed settings.
3. Run `cordon doctor` as the developer. It shows the home, the policy and the state.
4. Ask the agent to write a file outside the profile. The call should be refused, with the reason in the transcript. With the default profile (`read`, `summarize`) any write is outside it.

### What was verified

On 26 September 2026 this was run with Cordon 0.7.0 and Claude Code 2.1.282 on macOS. A managed settings file of the shape above was installed at the macOS path. The test project attacked in every way listed at the top of this page. Its `.claude/settings.json` set `disableAllHooks: true` and disabled `cordon@cordon`. Its `env` pointed `CORDON_HOME` at a planted permissive policy inside the project, and set `NODE_OPTIONS` to `--require` a script that leaves a marker file when loaded.

- **Control, without the managed file:** `claude -p` asked to write a file, and the file was written.
- **With the managed file:** the same prompt was refused with `outside the certificate: create, update`, and the model reported that reason. The refusal was journaled in the managed home. The planted home was never touched, so the managed `CORDON_HOME` won over the project's. The hook ran, since session state appeared in the managed home, and no marker file appeared, so the project's `NODE_OPTIONS` never reached it. `disableAllHooks` and the disabled plugin changed nothing.

Not covered by this run: `/status` and `claude doctor` output, server-managed settings, MDM delivery, Linux and Windows paths.

## Audit logs

Every refusal, question, argument rewrite, memory write under exposure and MCP tool drift is appended to `notify.file` as JSON Lines:

```json
{"at":"2026-09-26T09:14:02.118Z","decision":"deny","tool":"WebFetch","reason":"…","source":"https://vendor.example/page"}
```

| Field | Meaning |
|---|---|
| `at` | ISO 8601 time |
| `decision` | `deny`, `ask`, `rewrite`, `memory`, `mcp-drift` |
| `tool` | the tool the decision is about |
| `reason` | the reason, in the same words the model and the human saw |
| `source` | the untrusted source the decision turned on, or `null` |

On a single machine, `cordon log` prints the journal for a human, with control characters from source labels escaped.

Cordon has no network in its core, by design, so it never ships logs itself. Point your existing log shipper (Fluent Bit, Vector, the Datadog or Splunk agent) at the file:

```yaml
policy.yaml:
notify:
  file: /var/log/cordon/events.jsonl
```

A failure to write the journal never turns a refusal into a pass: notification is a side effect, and the decision stands without it.

## CI

`cordon audit` reads the agent configuration a repository carries: instruction files, skills, MCP servers and project hooks. It emits SARIF for code scanning, and `--fail-on` gates the build. It runs nothing it reads. See [audit.md](audit.md).

## Latency

Claude Code does not block a call whose hook timed out, so hook speed is part of the defence rather than a matter of comfort. Measured with `node scripts/bench-hook.mjs` on an Apple M1 Max with Node 24, process start included:

| Event | p50 | p95 |
|---|---|---|
| PreToolUse | 54 ms | 58 ms |
| PostToolUse, 211 KB page | 99 ms | 101 ms |

The plugin's timeouts are 5 s for PreToolUse and 10 s for PostToolUse, against Claude Code's default of 30 s. Run the script on your own hardware before tightening them.

## What Cordon does not provide

These are absent by design. Each one would need a network service in the path Cordon exists to keep clean:

- no dashboard, no SSO, no hosted policy server;
- no telemetry, no model calls, no threat-intelligence feed;
- no SLA: it is an MIT-licensed project.

What it offers in their place is a decision you can reproduce by reading the code on the same input, plus files your existing infrastructure already knows how to ship, version and review.
