/**
 * Credentials by their shape, for the rule that a call must not carry one
 * off the machine.
 *
 * This is the careless case, not the injected one: an agent pastes a token
 * into a curl command or a pastebin body because the task seemed to need it.
 * The exposure rule already answers a page that asks for a key; nothing
 * answered an agent that did it unprompted. Competitors ship the same check
 * (Docker's gateway, Lasso, Snyk), and it needs no model: a credential has a
 * shape.
 *
 * Every shape demands the length a real credential has, because each prefix
 * alone is an ordinary word somewhere: `sk-learn`, a file called
 * `ghp_notes`, AKIA in a sentence about AWS keys.
 */
const SHAPES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u },
  { kind: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/u },
  { kind: 'OpenAI API key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/u },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[0-9]{6,}-[A-Za-z0-9-]{10,}/u },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { kind: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/u },
  { kind: 'Stripe secret key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}/u },
  { kind: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u },
]

/** The kinds of credential found in a text; the credentials themselves are never returned. */
export function secretKinds(text: string, exempt: ReadonlySet<string> = new Set()): string[] {
  const kinds: string[] = []
  for (const { kind, pattern } of SHAPES) {
    const global = new RegExp(pattern.source, 'gu')
    for (const match of text.matchAll(global)) {
      if (exempt.has(match[0].toLowerCase())) continue
      // Anthropic keys also fit the OpenAI shape; one credential, one name.
      if (kind === 'OpenAI API key' && match[0].startsWith('sk-ant-')) continue
      if (!kinds.includes(kind)) kinds.push(kind)
    }
  }
  return kinds
}
