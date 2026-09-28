# How Cordon compares

This page places Cordon among the tools that defend agents against indirect prompt injection. Most facts here come from each project's own publications and were gathered in September 2026. Numbers are the vendors' or the papers' own, measured on different models and benchmark subsets, so they do not compare directly with each other or with Cordon's battery. If something here is out of date, open an issue.

## The one axis that sorts the field

Most shipping defences decide by **reading the text**. A classifier or an LLM judge sits in the path and scores whether content or a planned action looks malicious. Examples are Lakera Guard, Azure Prompt Shields, Meta's PromptGuard and AlignmentCheck in LlamaFirewall, NeMo Guardrails' self-check rails and Lasso's guardrail API. These tools catch plain-language injections that Cordon, by design, does not. Their failure mode is shared: an adaptive attacker who can query the judge writes around it. "The Attacker Moves Second" (2025) reported over 90% bypass of twelve published defences under adaptive attack.

Cordon decides without reading for meaning. It strips what a human cannot see, records where data came from, and gates calls by effect class, by provenance and by the **fact** that untrusted content was read. There is no model in the path, so the answer to the same input is always the same and can be checked by reading the code. The research designs closest to this are Google DeepMind's CaMeL and Microsoft's FIDES, both information-flow control. Neither ships as a hook for an existing coding agent. CaMeL needs the agent rebuilt around its interpreter. FIDES shipped in May 2026 as an experimental feature of Microsoft's Agent Framework and works for agents built on that framework. In both, the check before a call is deterministic, while a model plans the calls. CaMeL also runs a quarantined model, and so does the shipped FIDES. FIDES keeps one integrity label per session, so after an untrusted read every tool that is not on its allow list is refused. Cordon's exposure rule asks one more question: did the user name this target?

## The closest neighbours

We read the source of these projects in September 2026. What follows is their design as the code shows it, not their marketing.

- **IntentCap** (arXiv:2609.14631, a workshop paper, September 2026) is the closest published design. Each capability field has one owning source: the user, workflow instructions, the tool schema or the runtime environment. Leases can only narrow the user's authority, and a deterministic checker decides. The differences from Cordon:
  - IntentCap uses a model to propose leases, from context that includes untrusted content. Cordon has no model at all.
  - It needs structured user selections, while Cordon works from free-text messages.
  - It is evaluated by replaying traces, with adaptive attacks left to future work.

  Cordon reaches a similar invariant as a hook for shipping harnesses: a destination or controlled value must trace to the user's words, the policy, or a vouched lookup. We arrived at it independently and claim no priority.
- **Progent** (arXiv:2504.11703) is a per-tool privilege DSL, checked deterministically at call time. A model writes the policy from the user's query, and in its AgentDojo pipeline the model also rewrites the policy after each tool round, reading the tool result. An SMT check that updates only narrow exists in the code, behind an option.
- **Cupcake** (EQTY Lab) is the closest coding-agent hook: Rego policies compiled to WebAssembly, for Claude Code, Cursor, Factory and OpenCode. It judges each call on its own, with no memory that the session read untrusted content. An optional LLM judge ("Watchdog") can join the decision.
- **Microsoft Agent Governance Toolkit** is a broad governance framework with Rego, Cedar and YAML policies and plugins for Claude Code, Codex, Copilot and OpenCode. Its runtime keeps no taint by design: its policy specification leaves provenance to the host. Its Claude Code plugin checks calls before they run, but does not inspect tool output.
- **Docker MCP Gateway** runs MCP servers in containers, verifies the signatures of Docker's own catalogue images, and blocks secrets in arguments and results. Its policy decides by server and tool name, not by content or provenance.
- **Invariant Guardrails** is a rule language over agent traces. `a -> b` means "a came before b", and matching values is up to the rule author. Some predicates call a model, and the default `Policy` class sends the trace to Invariant's service unless `LOCAL_POLICY=1` is set.

## Side by side

| | Cordon | Classifier / LLM-judge firewalls (Lakera, Prompt Shields, LlamaFirewall, NeMo self-check) | MCP scanners (Snyk Agent Scan, Cisco mcp-scanner) | MCP gateways (Lasso, Deconvolute, MCP Guardian) |
|---|---|---|---|---|
| Decides by | effect class, provenance, the fact of an untrusted read | a model's score of the text | static rules, plus an optional LLM or cloud analysis | policies and plugins; some call a cloud API |
| Model or network in the decision path | no | yes | Snyk: descriptions go to Snyk's API; Cisco: offline mode available | varies; Lasso's injection filter is a cloud API |
| Runtime or pre-deploy | both (`audit` before, hooks and gateway at run time) | runtime | pre-deploy (Snyk added a proxy mode in 2026) | runtime |
| Catches a plain-language injection | no, by design; the exposure rule escalates what such an injection orders | yes, until adapted around | partly, by rules | partly |
| Paraphrased or encoded payload after an untrusted read | escalated by the exposure rule (battery: 56% → 10% on the working profile, every remaining row listed in the report); base64, hex and percent forms are also decoded and matched | depends on the judge | n/a | n/a |
| Poisoned memory that acts in a later session | memory ledger | not addressed in the open tools we found | n/a | n/a |
| Rug pull (a tool description changes after approval) | pinned on first sight, held until approved | n/a | Snyk: server-side, not in the open client | Deconvolute: pinned; Docker and Lasso gateways: not pinned |
| Hidden layer (invisible characters, hidden HTML) | stripped before the model reads it | model-dependent | flagged in descriptions and skills | some |
| Account required | no | usually | Snyk: yes | varies |
| Harnesses | Claude Code, Gemini CLI, any MCP host, LangChain | API-level | config files of many hosts | MCP hosts |

## What Cordon does not do, and who does

- **Judge the meaning of visible text.** If an honestly visible review persuades the agent, that is outside Cordon's scope. A classifier is the tool for that job, and Cordon can sit beside one: Cordon's decision does not depend on anything a classifier says.
- **Discovery and inventory across a fleet, dashboards, SSO.** Enterprise platforms (Zenity, Noma, Pillar, HiddenLayer, Prompt Security at SentinelOne) sell this. Cordon writes JSON Lines for the log shipper you already run ([enterprise.md](enterprise.md)) and has no server of its own.
- **Run MCP servers in a sandbox to see what they do.** Cisco's scanner does this at audit time. A pin records what a server says about a tool, not what the tool does.
- **Secrets and PII in arguments.** Cordon refuses a call that would carry a credential off the machine, but it knows fewer shapes than Docker's gateway, whose rules come from Trivy. It does not mask PII; Lasso and Presidio-based gateways do.
- **Kernel-level enforcement.** Meta's mcpguard-dynamic confines MCP servers with eBPF: file paths, connections and executables per process. It sees what a server does beneath its arguments, and none of the meaning of a call. Cordon sees the call and not the process. The two layers complement each other.
- **Public benchmark numbers.** CaMeL, FIDES, Progent and LlamaFirewall report AgentDojo results, and so does Cordon ([agentdojo.md](agentdojo.md)). With an agent that obeys every injection, no attack got through on any suite. Utility was 97 of 97 tasks in interactive mode and 14–75% per suite on a strict autonomous policy. On live models, 0 of 80 attacks got through with Laguna S 2.1, against 30 of 80 undefended. The numbers are not one-to-one comparable with the others', and the page says why. Among the coding-agent hooks we read, none published such numbers.

## Where to read more

- CaMeL: arXiv:2503.18813. FIDES: arXiv:2505.23643, shipped in Microsoft Agent Framework (`agent_framework/security.py`). Design Patterns for Securing LLM Agents: arXiv:2506.08837.
- IntentCap: arXiv:2609.14631, github.com/yunwei37/agentcap. Progent: arXiv:2504.11703, github.com/sunblaze-ucb/progent.
- Cupcake: github.com/eqtylab/cupcake. Microsoft Agent Governance Toolkit: github.com/microsoft/agent-governance-toolkit. Docker MCP Gateway: github.com/docker/mcp-gateway. Invariant: github.com/invariantlabs-ai/invariant. mcpguard-dynamic: github.com/facebook/mcpguard-dynamic.
- LlamaFirewall: arXiv:2505.03574. Spotlighting: arXiv:2403.14720.
- Memory injection: MINJA, arXiv:2503.03704; Claws, arXiv:2607.05189.
- Snyk Agent Scan (formerly Invariant's mcp-scan): github.com/snyk/agent-scan. Cisco mcp-scanner: github.com/cisco-ai-defense/mcp-scanner. Lasso MCP Gateway: github.com/lasso-security/mcp-gateway.
