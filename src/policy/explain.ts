import type { EffectClass } from '../core/types.js'
import type { Policy } from './defaults.js'

/**
 * A policy read back in plain words, and the lines in it worth a second look.
 *
 * The owner approves a mandate by reading it, and a model may have drafted
 * it: the drafting happens outside Cordon (invariant 1), the reading back
 * happens here, by code. So the words say what the gate does with each
 * field, including what it does not do, because that is where a drafted
 * mandate and the owner's belief part ways: `destinations` exempts after a
 * read and confines nothing, `tools` classifies and allows nothing, an empty
 * list of paths bounds nothing (Codex).
 *
 * Both take the effective policy, defaults merged in, so a default the file
 * did not write is explained too (Kimi).
 */

const ALL_EFFECTS: readonly EffectClass[] = [
  'read', 'summarize', 'create', 'update', 'delete', 'export', 'network-egress', 'financial', 'exec',
]

const IRREVERSIBLE: ReadonlySet<EffectClass> = new Set(['delete', 'export', 'financial'])

/**
 * Effects an unattended agent can repeat at someone else's cost: what
 * leaves the machine, and a post or a message it creates.
 */
const REPEATABLE: ReadonlySet<EffectClass> = new Set(['network-egress', 'export', 'financial', 'create'])

/**
 * Mailbox providers anyone can register at: `*@gmail.com` names every stranger
 * with an account there, which is the attacker's address too.
 */
const PUBLIC_MAIL: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'mail.ru', 'yandex.ru', 'ya.ru',
])

export interface LintFinding {
  /** warning: the line likely grants more than meant. note: worth knowing. */
  level: 'warning' | 'note'
  text: string
}

export function explain(policy: Policy): string[] {
  const lines: string[] = []
  lines.push(
    policy.mode === 'interactive'
      ? 'Mode: interactive. When a call is in doubt, Cordon asks you.'
      : 'Mode: autonomous. When a call is in doubt, Cordon refuses it and writes it to the journal; nobody is asked.',
  )

  const granted = policy.profile.effects
  const withheld = ALL_EFFECTS.filter((effect) => !granted.includes(effect))
  lines.push(`The agent may: ${granted.join(', ') || 'nothing'}.`)
  if (withheld.length > 0) lines.push(`It may not: ${withheld.join(', ')}.`)

  const { paths, hosts } = policy.profile.resources
  lines.push(paths.length === 0 ? 'Files: anywhere the effects above reach; no path bound is set.' : `Files: only under ${paths.join(', ')}.`)
  lines.push(hosts.length === 0 ? 'Hosts: any; no host bound is set.' : `Hosts: only ${hosts.join(', ')}.`)

  if (policy.exposure) {
    lines.push(
      'After the agent reads untrusted content (a page, a tool result), a call that acts beyond reading goes through ' +
        'only when every destination in it was named by you in your message' +
        (policy.destinations.length > 0 ? ' or is on the destinations list below' : '') +
        (policy.mode === 'interactive' ? '; otherwise you are asked.' : '; otherwise it is refused until your next message.'),
    )
  } else {
    lines.push(
      'The exposure rule is OFF: reading untrusted content changes nothing by itself, and only a match against what was read is caught.',
    )
  }

  if (policy.destinations.length > 0) {
    const shown = policy.destinations.map((entry) => (entry.startsWith('*') ? `anything ending in ${entry.replace(/^\*+/u, '')}` : entry))
    lines.push(
      `Destinations counted as named by you after an untrusted read: ${shown.join('; ')}. ` +
        'They do not limit where the agent may send before it reads anything untrusted; the effects above do that.',
    )
  }
  if (policy.task !== null) lines.push(`Task, standing in for your words where no message arrives: "${policy.task}".`)

  const tools = Object.entries(policy.tools)
  if (tools.length > 0) {
    lines.push(
      `Tools: ${tools.map(([tool, effects]) => `${tool} counts as ${effects.join(' and ') || 'nothing (refused)'}`).join('; ')}. ` +
        'This classifies a tool, it does not allow it: a tool whose class is not granted above is still refused.',
    )
  }

  for (const [tool, roles] of Object.entries(policy.arguments)) {
    for (const [field, role] of Object.entries(roles)) {
      if (role === 'controlled') {
        lines.push(`${tool}.${field} is controlled: after an untrusted read it must hold a value you assigned in your message, by name.`)
      } else {
        lines.push(`${tool}.${field} is read as a ${role}.`)
      }
    }
  }

  for (const [tool, lookup] of Object.entries(policy.lookups)) {
    const fills = Object.entries(lookup.values).map(([field, consumers]) => `${field} may fill ${consumers.join(', ')}`).join('; ')
    lines.push(`${tool} is a lookup: asked with a name you said (${lookup.query}), its ${lookup.key} record vouches that ${fills}.`)
  }

  for (const budget of policy.budgets ?? []) {
    lines.push(`Budget: at most ${budget.limit} ${budget.effect} calls per ${budget.per}, across every session under this policy; past it a call is refused, and no approval lifts that.`)
  }
  if (policy.trustedSources.length > 0) {
    lines.push(`Trusted without scanning: ${policy.trustedSources.join(', ')}. Content from these never marks the session.`)
  }
  if (policy.memory.files.length > 0 || policy.memory.tools.length > 0) {
    lines.push(`Memory the agent reloads, besides the harness's own files: ${[...policy.memory.files, ...policy.memory.tools].join(', ')}.`)
  }
  lines.push(policy.mcp.pin ? 'MCP tools are pinned on first sight; a tool that changes is held until you approve the server.' : 'MCP tools are not pinned: a server may change a tool under the agent.')
  lines.push(policy.notify.file === null ? 'Journal: none.' : `Journal: ${policy.notify.file}.`)
  return lines
}

export function lint(policy: Policy): LintFinding[] {
  const found: LintFinding[] = []
  const granted = policy.profile.effects

  if (!policy.exposure) {
    found.push({ level: 'warning', text: 'the exposure rule is off: a paraphrased or encoded attack that repeats nothing it read goes through' })
  }
  for (const entry of policy.destinations) {
    const broad = broadDestination(entry)
    if (broad !== null) found.push({ level: 'warning', text: `destination ${entry} ${broad}` })
  }
  // A read-only default refuses nothing an owner is waiting on.
  const acts = granted.some((effect) => effect !== 'read' && effect !== 'summarize')
  if (policy.mode === 'autonomous' && policy.notify.file === null && acts) {
    found.push({ level: 'warning', text: 'autonomous mode with no journal (notify.file): a refusal overnight is seen by nobody' })
  }
  for (const source of policy.trustedSources) {
    found.push({ level: 'warning', text: `${source} is trusted: whatever it serves is read as your own, with no scanning` })
  }
  if (!policy.mcp.pin) {
    found.push({ level: 'warning', text: 'mcp.pin is off: a server can change a tool\'s description after you approved it' })
  }
  if (policy.mode === 'autonomous' && granted.includes('exec')) {
    found.push({ level: 'warning', text: 'exec in autonomous mode: a shell command is never aimed by a name, so after an untrusted read every one is refused, and before it any one runs' })
  }
  for (const effect of granted) {
    if (IRREVERSIBLE.has(effect)) found.push({ level: 'note', text: `${effect} is granted, and it cannot be undone` })
  }
  if ((granted.includes('network-egress') || granted.includes('exec')) && policy.profile.resources.hosts.length === 0) {
    found.push({ level: 'note', text: 'the network is granted with no hosts listed: any host is reachable' })
  }
  const budgeted = new Set((policy.budgets ?? []).map((budget) => budget.effect))
  const unbudgeted = granted.filter((effect) => REPEATABLE.has(effect) && !budgeted.has(effect))
  if (policy.mode === 'autonomous' && unbudgeted.length > 0) {
    found.push({ level: 'note', text: `no budget caps ${unbudgeted.join(', ')}: an unattended agent can repeat it as often as it is steered to` })
  }
  if (policy.mode === 'autonomous' && policy.task === null && policy.destinations.length === 0 && policy.exposure) {
    found.push({ level: 'note', text: 'no task and no destinations: after an untrusted read, every call that acts is refused' })
  }
  return found
}

/** Why a destination pattern names strangers, or null. */
function broadDestination(entry: string): string | null {
  if (!entry.startsWith('*')) return null
  const suffix = entry.replace(/^\*+/u, '').toLowerCase()
  const at = suffix.lastIndexOf('@')
  const domain = (at >= 0 ? suffix.slice(at + 1) : suffix).replace(/^\.+/u, '')
  if (at >= 0 && PUBLIC_MAIL.has(domain)) return 'matches every mailbox at a public provider, the attacker\'s included'
  if (!domain.includes('.')) return 'matches a whole domain zone'
  return null
}
