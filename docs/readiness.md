# Readiness

This page tracks what Cordon took from the tools it is compared with in [comparison.md](comparison.md), what it chose not to take, and what is still open. Every "done" row names the test or live run that checks it, so a claim here can be verified by reading the code. The page was last reviewed at 0.7.0, on 26 September 2026.

## Taken from the field

| What | Seen in | In Cordon | Checked by |
|---|---|---|---|
| Rug-pull protection: pin a tool's description and schema, hold a tool that changed | Snyk Agent Scan (formerly mcp-scan), Deconvolute | the gateway pins on first sight; `cordon mcp approve -- <cmd>` accepts a change | `tests/gate/pins.test.ts`, `tests/session/pins.test.ts`, `tests/adapters/mcp/gateway.test.ts` |
| Pre-deploy scan of agent configuration with stable codes, OWASP mapping and SARIF | Snyk Agent Scan, Cisco mcp-scanner | `cordon audit`, codes CA101–CA901 ([audit.md](audit.md)) | `tests/audit/audit.test.ts`, the CI self-audit step |
| Cleaning text hidden inside a tool's `inputSchema` | MCP scanners | `description` and `title` at any depth up to 16 levels | `tests/adapters/mcp/gateway.test.ts` |
| One-command setup with named profiles | AgentWall-style installers | `cordon init --profile locked\|research\|documents\|coding` | `tests/policy/templates.test.ts`, `tests/cli.test.ts` |
| Status and an event view for the owner | AgentWall, gateway dashboards | `cordon doctor`, `cordon log` | `tests/cli.test.ts` |
| An audit log a SIEM can ingest | Lasso, enterprise platforms | JSON Lines at `notify.file`, schema in [enterprise.md](enterprise.md#audit-logs) | `tests/cordon.test.ts` |
| Fleet deployment that a repository cannot switch off | enterprise platforms | Claude Code managed settings with `allowManagedHooksOnly` ([enterprise.md](enterprise.md)) | run on one managed macOS machine with Claude Code 2.1.282 against a project that tries every switch-off ([enterprise.md](enterprise.md#what-was-verified)) |
| A signed provenance for the published package | npm ecosystem practice | `release.yml` publishes with `--provenance` | the release workflow; first run at the 0.7.0 tag |
| A decision that answers to what was read, not only to what matched | FIDES, CaMeL (information-flow control) | the exposure rule and the memory ledger | `tests/adversarial/asr.test.ts` (the battery fails on a regression) |
| One decision on every transport | the design's own claim, unmeasured before | nine scenarios through Claude Code, Gemini CLI, the MCP gateway and LangChain, compared down to the refusal's reason | `tests/adversarial/transports.test.ts` |
| The model told when a call was changed under it | FIDES-style labels on results | quarantine rewrites carry `additionalContext` to the model | `tests/adapters/claude-code/protocol.test.ts`, [live-run.md](live-run.md) |

## Considered and not taken

- **A classifier or LLM judge.** Lakera, Prompt Shields, PromptGuard and NeMo self-check decide by meaning. Cordon's first invariant is no model in the decision path ([AGENTS.md](../AGENTS.md)). A classifier can run beside Cordon, and Cordon's decision does not depend on it.
- **A confusables filter.** Cordon never matches text against keywords, so lookalike letters cannot slip past a keyword. What matters is that a fullwidth or mathematical-bold link on a page still matches the plain link in a call. It does, through NFKC in provenance (`tests/provenance/store.test.ts`), and mixed scripts inside one word are flagged by sanitize.
- **Per-call approvals kept by Cordon.** In interactive mode the harness asks the human on every escalated call, which is a one-shot approval by construction. Caching an approval across calls is state an attacker can aim at (see "Things that look like improvements" in [AGENTS.md](../AGENTS.md)).
- **A source label read from nested arguments.** The label decides which declared trusted source a result counts as. Reading it from a nested field would let a call carry a trusted link beside the one it actually fetches, and the result would be classified by the decoy. Only top-level `url`, `path` and their spellings name a source; everything else is named by the tool.
- **A hosted dashboard, SSO, telemetry.** Each would put a network service into the path. The journal is a file for the shipper you already run.

## Open

- **AgentDojo numbers.** The battery checks Cordon's own mechanism; it is not comparable with published AgentDojo results. A run needs model calls and a budget, and is the most useful missing number.
- **Secrets in arguments at run time.** `audit` flags a literal secret in configuration; nothing scans call arguments for credentials. The exposure rule escalates egress after an untrusted read, which covers the injected case, not the careless one.
- **Cross-server tool shadowing.** One gateway fronts one server, and a description on server A that talks about a tool on server B is visible text. Pinning makes it stable; nothing judges it.
- **Remote MCP servers.** The gateway is stdio only; `audit` reports a remote server as CA204.
- **A managed-settings rollout beyond one machine.** The file-based deployment was verified on one macOS machine. Server-managed settings, MDM delivery, and the Linux and Windows paths have not been run.
