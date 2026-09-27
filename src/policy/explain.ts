import type { EffectClass } from '../core/types.js'
import type { Policy } from './defaults.js'
import { destinationPattern } from './destinations.js'
import { builtinEffects } from '../scope/effects.js'

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

/**
 * Tools whose result the human already sees as source.
 *
 * doctor and lint need them in order to name a dangerous declaration: `rendered` on
 * any of these brings back the bug where writing a file that had been read
 * destroyed its markup and scripts. The declaration cannot be forbidden — it
 * is a deliberate human decision — but staying silent about it is worse.
 */
export const SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'Bash',
  'read_file', 'read_many_files', 'list_directory', 'glob', 'search_file_content',
  'run_shell_command',
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
  if (granted.includes('exec') && (paths.length > 0 || hosts.length > 0)) {
    // Bounds read the path and URL fields of a call. A shell command's text
    // is not parsed, so "only under /safe" would be false next to it (Codex).
    lines.push('A shell command is not bounded by these: its text is not parsed, so it reaches any file and any host.')
  }

  if (policy.exposure) {
    lines.push(
      'After the agent reads untrusted content (a page, a tool result), a call that acts beyond reading goes through ' +
        'only when every destination in it was named by you in your message' +
        (policy.destinations.length > 0 ? ' or is on the destinations list below' : '') +
        (policy.mode === 'interactive' ? '; otherwise you are asked.' : '; otherwise it is refused until your next message.'),
    )
    // Two holds the sentence above does not cover (Kimi): a read aimed at
    // something the page named, and the agent rewriting its own settings.
    lines.push(
      'The same holds for a read of a resource you never named (a repository, a document the page pointed at), ' +
        'and for any write to the agent\'s own configuration.',
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

  for (const [tool, view] of Object.entries(policy.toolsReturn)) {
    lines.push(
      view === 'rendered'
        ? `${tool} returns rendered output: the hidden layer (invisible characters, hidden markup) is stripped from its result.`
        : `${tool} returns source: its result is passed as it is, with nothing stripped.`,
    )
  }
  if (!policy.output.footer) lines.push('The source footer under the agent\'s answer is off: an answer shaped by what the agent read says nothing about it.')

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
    found.push({ level: 'warning', text: 'exec in autonomous mode: before an untrusted read any shell command runs unasked, and after one a command runs whenever what it names was named by you' })
  }
  if (granted.includes('exec')) {
    found.push({ level: 'note', text: 'exec is granted: a shell command\'s text is not parsed, so no path or host bound reaches it' })
  }
  for (const [tool, effects] of Object.entries(policy.tools)) {
    // A declaration replaces the built-in class. `Bash: [read]` makes every
    // command a read, and a read-only profile then runs `rm -rf` (Codex).
    const dropped = (builtinEffects(tool) ?? []).filter((effect) => !effects.includes(effect))
    if (dropped.length > 0) {
      found.push({ level: 'warning', text: `${tool} is declared without ${dropped.join(', ')}, which it has built in: its calls are judged as the smaller class` })
    }
  }
  for (const [tool, view] of Object.entries(policy.toolsReturn)) {
    if (view === 'rendered' && SOURCE_TOOLS.has(tool)) {
      found.push({ level: 'warning', text: `${tool} is declared as returning rendered output: the file comes back rendered, and written back it is destroyed` })
    }
  }
  if (granted.some((effect) => effect === 'create' || effect === 'update' || effect === 'delete') && policy.profile.resources.paths.length === 0) {
    found.push({ level: 'note', text: 'files are written with no paths listed: any path is writable' })
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
  // Read as the gate reads it: `' *@GMAIL.com '` is `*@gmail.com` there (Codex).
  const pattern = destinationPattern(entry)
  if (!pattern.startsWith('*')) return null
  const suffix = pattern.replace(/^\*+/u, '')
  const at = suffix.lastIndexOf('@')
  const domain = (at >= 0 ? suffix.slice(at + 1) : suffix).replace(/^\.+/u, '')
  // A suffix match: `*gmail.com` takes every gmail mailbox, and notgmail.com
  // with it; `*@mail.gmail.com` is still the provider's (Kimi).
  for (const provider of PUBLIC_MAIL) {
    if (domain === provider || domain.endsWith(`.${provider}`)) return 'matches every mailbox at a public provider, the attacker\'s included'
  }
  if (!domain.includes('.')) return 'matches a whole domain zone'
  return null
}
