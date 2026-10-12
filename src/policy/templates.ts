import { join } from 'node:path'
import type { EffectClass, PresenceMode } from '../core/types.js'
import type { Budget } from './defaults.js'

export interface ProfileTemplate {
  summary: string
  mode: PresenceMode
  effects: EffectClass[]
  /** Rate limits written into the file; only the unattended profile has them. */
  budgets?: Budget[]
}

/**
 * Starting points for `cordon init`, from narrowest to widest.
 *
 * None grants delete, export or financial: those are irreversible, and
 * granting them is a line the owner writes, not one a template writes for
 * them. Every widened profile for a person at a terminal is interactive,
 * because in autonomous mode the exposure rule refuses what interactive mode
 * asks about, and a new user meets that as "Cordon broke my agent" before
 * reading why. `service` is the one for an agent nobody watches: there a
 * refusal is the right answer to doubt, the mandate is written in advance,
 * and budgets cap what it can do however it was steered.
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
  service: {
    summary: 'an unattended agent (a LangChain service, a cron bot): doubt is a refusal, destinations are declared in advance, and every outward effect is budgeted',
    mode: 'autonomous',
    effects: ['read', 'summarize', 'create', 'network-egress'],
    budgets: [
      { effect: 'network-egress', limit: 20, per: 'hour' },
      { effect: 'create', limit: 50, per: 'hour' },
    ],
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

# Refuse an exact tool name even when its effects are granted. This can keep
# the native shell closed while a separately isolated executor uses exec.
# blockedTools: [Bash]

# Memory the agent reloads in later sessions, beyond CLAUDE.md and the like.
# memory:
#   files: [TEAM-RULES.md]
#   tools: [mem0_add]

${profile.budgets === undefined ? '' : `# How many calls of an effect may go through per window, across every
# session under this policy: however the agent was steered, no more than
# this. A call over it is refused and journaled with the rule budget.
budgets:
${profile.budgets.map((budget) => `  - { effect: ${budget.effect}, limit: ${budget.limit}, per: ${budget.per} }`).join('\n')}

# Nobody names a destination during an unattended run, so the task and the
# destinations it sends to are written down here. Check the file with
# \`cordon policy check\` and read it back with \`cordon policy explain\`.
# task: answer customer tickets for acme.example
# destinations: ['*@acme.example']

`}# Every refusal, question and rewrite is appended here as JSON Lines.
notify:
  file: ${join(cordonHome, 'events.jsonl')}
`
}
