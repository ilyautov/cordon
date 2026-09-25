# `cordon audit`

`cordon audit` reads what an agent will load before it runs: instruction files, skills, MCP server configurations and hooks. It reports what a reviewer should look at.

It runs nothing. No server is started, no package is fetched, and there is no network call and no account. It reads files, so it is safe in CI on a pull request from a stranger and on an air-gapped machine.

```bash
npx @ilyautov/cordon audit                 # the current project and your home directory
npx @ilyautov/cordon audit path/to/repo
npx @ilyautov/cordon audit --json          # the findings as JSON
npx @ilyautov/cordon audit --sarif         # SARIF 2.1.0, for code scanning
npx @ilyautov/cordon audit --fail-on high  # exit 1 when a finding is at or above this severity
```

Without `--fail-on` the exit code is 0. A finding is a signal, and whether it fails a build is your decision.

## What is read

| Where | Files |
|---|---|
| Project | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`; markdown under `.claude/skills`, `.claude/commands`, `.claude/agents`, `.gemini/commands`; `.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`; `.claude/settings.json`, `.claude/settings.local.json` |
| Home | `.claude/CLAUDE.md`, `.gemini/GEMINI.md` and the same skill, command and agent directories; `.claude.json` (including per-project servers), `.cursor/mcp.json`, `.gemini/settings.json`, `.codeium/windsurf/mcp_config.json`, the Claude Desktop config; `.claude/settings.json` |

Files over 1 MB are skipped: nobody reviews those by eye as instructions.

## Findings

Codes are stable. A code is never renumbered or reused, so a CI rule or a report can cite it. The mapping is to the [OWASP Top 10 for LLM Applications, 2025](https://genai.owasp.org/llm-top-10/).

| Code | Severity | OWASP | What it means |
|---|---|---|---|
| CA101 | high | LLM01 Prompt Injection | Invisible characters in a file the agent loads as instruction. Zero-width characters, Unicode tag characters or bidi controls hide from every editor, and the model reads them. This is the vector from the February 2026 demonstration of instructions in `SKILL.md`. |
| CA102 | medium | LLM01 Prompt Injection | An encoded block (base64 and similar) in an instruction file. The model can decode it, and a reviewer reads past it. |
| CA103 | low | LLM01 Prompt Injection | Markup hidden when rendered: an HTML comment, a hidden element, a machine-only attribute. It is visible in the source, where these files are edited, and hidden in a rendered preview such as GitHub's. |
| CA104 | low | LLM01 Prompt Injection | A word mixing scripts. Most often it is a brand or slang, sometimes a homoglyph. The finding shows up to three samples, so check them. |
| CA201 | medium | LLM01 Prompt Injection | A stdio MCP server that is not behind the Cordon gateway. Its descriptions and results reach the model uncleaned, and its calls are not gated. The fix is `cordon mcp -- <command>`. |
| CA202 | medium | LLM03 Supply Chain | An MCP server package started through `npx`, `bunx`, `uvx` or `pipx` without a pinned version. The server you reviewed is not necessarily the one that starts tomorrow. |
| CA203 | high | LLM02 Sensitive Information Disclosure | A literal secret in a server's `env` or `headers`. The finding names the key, never the value. |
| CA204 | low | LLM01 Prompt Injection | A remote (HTTP or SSE) MCP server. The stdio gateway cannot cover it. |
| CA301 | medium | LLM03 Supply Chain | A hook defined in the project's own `.claude/settings.json`. It came with `git clone`, and it runs on the machine of whoever starts the agent in the directory. |
| CA303 | high | LLM03 Supply Chain | The project's settings or its MCP configuration set environment that steers Cordon or the hook process: `CORDON_*`, `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_PRELOAD`, `DYLD_*`. Claude Code hands a project's `env` to hook processes. A `CORDON_HOME` inside the project is refused at run time as well. |
| CA302 | low | LLM01 Prompt Injection | Claude Code is installed and neither the Cordon plugin nor a `cordon hook` command is configured. |
| CA901 | medium | LLM03 Supply Chain | A configuration file that could not be parsed. |

## In CI

```yaml
- run: npx -y @ilyautov/cordon@0.7.0 audit --sarif > cordon.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: cordon.sarif
- run: npx -y @ilyautov/cordon@0.7.0 audit --fail-on high
```

Pin the version, for the same reason CA202 exists.

## What it does not do

- **It judges no one's intent.** A plainly written instruction to exfiltrate data, visible to anyone who reads the file, is not a finding. That is a question about meaning, and Cordon does not ask it. What `audit` finds is concealment, and exposure the configuration creates.
- **It does not run servers.** A server's tool descriptions are not known until it starts. The gateway sees them at run time, cleans them and pins them. See [install-mcp.md](install-mcp.md#tool-pinning).
- **It does not read plugins' own directories.** Installed plugins bring their own skills. Audit their source repository.
