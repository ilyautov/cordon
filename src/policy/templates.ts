import { join } from 'node:path'
import type { EffectClass, PresenceMode } from '../core/types.js'

export interface ProfileTemplate {
  summary: string
  mode: PresenceMode
  effects: EffectClass[]
}

/**
 * Starting points for `cordon init`, from narrowest to widest.
 *
 * None grants delete, export or financial: those are irreversible, and
 * granting them is a line the owner writes, not one a template writes for
 * them. Every widened profile is interactive, because in autonomous mode
 * the exposure rule refuses what interactive mode asks about, and a new user
 * meets that as "Cordon broke my agent" before reading why.
 */
export const PROFILES: Readonly<Record<string, ProfileTemplate>> = {
  locked: {
    summary: 'read and summarize only; the default policy, written out',
    mode: 'autonomous',
    effects: ['read', 'summarize'],
  },
  research: {
    summary: 'read the web and local files, write nothing',
    mode: 'interactive',
    effects: ['read', 'summarize', 'network-egress'],
  },
  documents: {
    summary: 'read and write files, no shell, no network',
    mode: 'interactive',
    effects: ['read', 'summarize', 'create', 'update'],
  },
  coding: {
    summary: 'a coding agent: files, the shell and the web, with every consequential call after an untrusted read put to you',
    mode: 'interactive',
    effects: ['read', 'summarize', 'create', 'update', 'exec', 'network-egress'],
  },
}

/** The policy file for a profile, commented for the person who will edit it. */
export function renderPolicy(name: string, cordonHome: string): string {
  const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined
  if (profile === undefined) {
    throw new Error(`unknown profile ${name}; the profiles are ${Object.keys(PROFILES).join(', ')}`)
  }
  return `# Cordon policy, written by \`cordon init --profile ${name}\`.
# ${profile.summary}
#
# Every key is documented in docs/install.md. A key the loader does not know
# stops the load, so a typo here is a refusal on every event, never a silent
# default. Check an edit with \`cordon doctor\`.

# interactive: a doubtful call is a question to you. autonomous: it is refused.
mode: ${profile.mode}

profile:
  # What the agent may do at all. Nine classes exist: read, summarize, create,
  # update, delete, export, network-egress, financial, exec.
  effects: [${profile.effects.join(', ')}]
  # Uncomment to bound where it may do it.
  # resources:
  #   paths: [/path/to/project]
  #   hosts: [api.example.com]

# After the session reads untrusted content, a call acting beyond reading
# escalates unless you named its destination yourself. The rule that stops
# paraphrased and encoded injections; switching it off is measured in
# docs/adversarial-report.md.
exposure: true

# MCP tools are declared here with their effect classes; an undeclared tool
# escalates. Example:
# tools:
#   mcp__github__create_issue: [create, network-egress]

# Memory the agent reloads in later sessions, beyond CLAUDE.md and the like.
# memory:
#   files: [TEAM-RULES.md]
#   tools: [mem0_add]

# Every refusal, question and rewrite is appended here as JSON Lines.
notify:
  file: ${join(cordonHome, 'events.jsonl')}
`
}
