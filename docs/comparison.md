# How Cordon compares

This page places Cordon among the tools that defend agents against indirect prompt injection. Most facts here come from each project's own publications and were gathered in September 2026. Numbers are the vendors' or the papers' own, measured on different models and benchmark subsets, so they do not compare directly with each other or with Cordon's battery. If something here is out of date, open an issue.

## The one axis that sorts the field

Most shipping defences decide by **reading the text**. A classifier or an LLM judge sits in the path and scores whether content or a planned action looks malicious. Examples are Lakera Guard, Azure Prompt Shields, Meta's PromptGuard and AlignmentCheck in LlamaFirewall, NeMo Guardrails' self-check rails and Lasso's guardrail API. These tools catch plain-language injections that Cordon, by design, does not. Their failure mode is shared: an adaptive attacker who can query the judge writes around it. "The Attacker Moves Second" (2025) reported over 90% bypass of twelve published defences under adaptive attack.

Cordon decides without reading for meaning. It strips what a human cannot see, records where data came from, and gates calls by effect class, by provenance and by the **fact** that untrusted content was read. There is no model in the path, so the answer to the same input is always the same and can be checked by reading the code. The research designs closest to this are Google DeepMind's CaMeL and Microsoft's FIDES, both information-flow control. Neither ships as a hook for an existing coding agent. CaMeL needs the agent rebuilt around its interpreter, and FIDES lives inside Microsoft's Agent Framework.

## Side by side

| | Cordon | Classifier / LLM-judge firewalls (Lakera, Prompt Shields, LlamaFirewall, NeMo self-check) | MCP scanners (Snyk Agent Scan, Cisco mcp-scanner) | MCP gateways (Lasso, Deconvolute, MCP Guardian) |
|---|---|---|---|---|
| Decides by | effect class, provenance, the fact of an untrusted read | a model's score of the text | static rules, plus an optional LLM or cloud analysis | policies and plugins; some call a cloud API |
| Model or network in the decision path | no | yes | Snyk: descriptions go to Snyk's API; Cisco: offline mode available | varies; Lasso's injection filter is a cloud API |
| Runtime or pre-deploy | both (`audit` before, hooks and gateway at run time) | runtime | pre-deploy (Snyk added a proxy mode in 2026) | runtime |
| Catches a plain-language injection | no, by design; the exposure rule escalates what such an injection orders | yes, until adapted around | partly, by rules | partly |
| Paraphrased or encoded payload after an untrusted read | escalated by the exposure rule (battery: 74% → 6%) | depends on the judge | n/a | n/a |
| Poisoned memory that acts in a later session | memory ledger | not addressed in the open tools we found | n/a | n/a |
| Rug pull (a tool description changes after approval) | pinned on first sight, held until approved | n/a | Snyk: yes, by scan | Deconvolute: pinned |
| Hidden layer (invisible characters, hidden HTML) | stripped before the model reads it | model-dependent | flagged in descriptions and skills | some |
| Account required | no | usually | Snyk: yes | varies |
| Harnesses | Claude Code, Gemini CLI, any MCP host, LangChain | API-level | config files of many hosts | MCP hosts |

## What Cordon does not do, and who does

- **Judge the meaning of visible text.** If an honestly visible review persuades the agent, that is outside Cordon's scope. A classifier is the tool for that job, and Cordon can sit beside one: Cordon's decision does not depend on anything a classifier says.
- **Discovery and inventory across a fleet, dashboards, SSO.** Enterprise platforms (Zenity, Noma, Pillar, HiddenLayer, Prompt Security at SentinelOne) sell this. Cordon writes JSON Lines for the log shipper you already run ([enterprise.md](enterprise.md)) and has no server of its own.
- **Run MCP servers in a sandbox to see what they do.** Cisco's scanner does this at audit time. A pin records what a server says about a tool, not what the tool does.
- **Secrets and PII in arguments.** Lasso and Presidio-based gateways mask these. Cordon's audit flags a literal secret in configuration, but nothing at run time scans arguments for credentials.
- **Public benchmark numbers.** CaMeL, FIDES and LlamaFirewall report AgentDojo results. Cordon's battery ([adversarial-report.md](adversarial-report.md)) measures its own decision layer against scripted attacks. That checks the mechanism, and it is not comparable with AgentDojo. An AgentDojo run is open work.

## Where to read more

- CaMeL: arXiv:2503.18813. FIDES: arXiv:2505.23643. Design Patterns for Securing LLM Agents: arXiv:2506.08837.
- LlamaFirewall: arXiv:2505.03574. Spotlighting: arXiv:2403.14720.
- Memory injection: MINJA, arXiv:2503.03704; Claws, arXiv:2607.05189.
- Snyk Agent Scan (formerly Invariant's mcp-scan): github.com/snyk/agent-scan. Cisco mcp-scanner: github.com/cisco-ai-defense/mcp-scanner. Lasso MCP Gateway: github.com/lasso-security/mcp-gateway.
