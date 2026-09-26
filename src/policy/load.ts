import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parse } from 'yaml'
import type { ArgumentRole, EffectClass, PresenceMode, SourceView } from '../core/types.js'
import { DEFAULT_POLICY, type Policy } from './defaults.js'

const EFFECTS: ReadonlySet<string> = new Set<EffectClass>([
  'read', 'summarize', 'create', 'update', 'delete',
  'export', 'network-egress', 'financial', 'exec',
])

const MODES: ReadonlySet<string> = new Set<PresenceMode>(['interactive', 'autonomous'])

const VIEWS: ReadonlySet<string> = new Set<SourceView>(['rendered', 'source'])

/**
 * Reads the policy ONLY from Cordon's home directory.
 *
 * The working directory takes no part here deliberately and never will: a
 * poisoned repository that brings its own config would switch the defence off
 * before it had a chance to fire.
 */
export function loadPolicy(cordonHome: string): Policy {
  const path = join(cordonHome, 'policy.yaml')

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_POLICY)
    throw new Error(`could not read ${path}: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch (error) {
    throw new Error(`${path} is broken: ${(error as Error).message}`)
  }

  return validate(parsed, path)
}

function validate(parsed: unknown, path: string): Policy {
  const policy = structuredClone(DEFAULT_POLICY)
  if (parsed === null || parsed === undefined) return policy
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: expected an object`)
  }
  const input = parsed as Record<string, unknown>
  onlyKnown(input, TOP_LEVEL, path, '')

  if ('mode' in input) {
    if (typeof input.mode !== 'string' || !MODES.has(input.mode)) {
      throw new Error(`${path}: mode must be interactive or autonomous, not ${String(input.mode)}`)
    }
    policy.mode = input.mode as PresenceMode
  }

  if ('profile' in input) {
    const profile = asObject(input.profile, `${path}: profile`)
    onlyKnown(profile, ['effects', 'resources'], path, 'profile.')
    if ('effects' in profile) {
      policy.profile.effects = asEffects(profile.effects, `${path}: profile.effects`)
    }
    if ('resources' in profile) {
      const resources = asObject(profile.resources, `${path}: profile.resources`)
      onlyKnown(resources, ['paths', 'hosts'], path, 'profile.resources.')
      policy.profile.resources = {
        paths: asStrings(resources.paths ?? [], `${path}: profile.resources.paths`),
        hosts: asStrings(resources.hosts ?? [], `${path}: profile.resources.hosts`),
      }
    }
  }

  if ('tools' in input) {
    const tools = asObject(input.tools, `${path}: tools`)
    policy.tools = {}
    for (const [name, value] of Object.entries(tools)) {
      policy.tools[name] = asEffects(value, `${path}: tools.${name}`)
    }
  }

  if ('trustedSources' in input) {
    policy.trustedSources = asStrings(input.trustedSources, `${path}: trustedSources`)
  }

  // The field is read as an own property: the policy file is parsed from outside.
  if (Object.hasOwn(input, 'toolsReturn')) {
    policy.toolsReturn = asViews(input['toolsReturn'], `${path}: toolsReturn`)
  }

  if (Object.hasOwn(input, 'arguments')) {
    policy.arguments = asRoles(input['arguments'], `${path}: arguments`)
  }

  if ('destinations' in input) {
    policy.destinations = asStrings(input.destinations, `${path}: destinations`)
    // A bare * would name every destination there is: the mandate would be
    // the exposure rule switched off under another name.
    for (const entry of policy.destinations) {
      if (entry.trim().replace(/^\*+/u, '') === '') throw new Error(`${path}: destinations: ${entry} matches everything`)
    }
  }

  if ('notify' in input) {
    const notify = asObject(input.notify, `${path}: notify`)
    // A refusal rather than a silent ignore. The field was accepted once and
    // nothing was ever sent to it: an owner who wrote a webhook here believed
    // they were being notified of blocked calls overnight and were not. A
    // setting that promises a safety property it does not deliver is worse
    // than no setting, so it stops the load instead of being dropped quietly.
    if (Object.hasOwn(notify, 'webhook')) {
      throw new Error(
        `${path}: notify.webhook is not delivered anywhere and never was; there is no network in ` +
          'the core by design. Write notify.file and deliver from that file if a webhook is wanted',
      )
    }
    onlyKnown(notify, ['file'], path, 'notify.')
    policy.notify = { file: journalPath(notify.file, path) }
  }

  // The field is read as an own property: the policy file is parsed from
  // outside, and `__proto__` inside it must not look like a setting.
  if (Object.hasOwn(input, 'exposure')) {
    const exposure = input['exposure']
    // A silent default here would mean the human switched the rule off, it
    // stayed on, and they never learned about it — the same argument as for
    // output.footer below.
    if (typeof exposure !== 'boolean') {
      throw new Error(`${path}: exposure must be true or false, not ${String(exposure)}`)
    }
    policy.exposure = exposure
  }

  // The field is read as an own property: the policy file is parsed from
  // outside, and `__proto__` inside it must not look like a setting.
  if (Object.hasOwn(input, 'task')) {
    const task = input['task']
    // A silent default here would mean the human wrote the task, it was
    // dropped, and every consequential call under the exposure mark escalated
    // without a word why — the same argument as for exposure above.
    if (typeof task !== 'string') {
      throw new Error(`${path}: task must be a string, not ${String(task)}`)
    }
    policy.task = task
  }

  // The field is read as an own property: the policy file is parsed from
  // outside, and `__proto__` inside it must not look like a setting.
  if (Object.hasOwn(input, 'memory')) {
    const memory = asObject(input['memory'], `${path}: memory`)
    onlyKnown(memory, ['files', 'tools'], path, 'memory.')
    // A silent default here would mean the human declared a memory store and
    // writes into it were never noticed — the same argument as for exposure.
    policy.memory = {
      files: asNames(Object.hasOwn(memory, 'files') ? memory['files'] : [], `${path}: memory.files`),
      tools: asNames(Object.hasOwn(memory, 'tools') ? memory['tools'] : [], `${path}: memory.tools`),
    }
  }

  // The field is read as an own property: the policy file is parsed from
  // outside, and `__proto__` inside it must not look like a setting.
  if (Object.hasOwn(input, 'mcp')) {
    const mcp = asObject(input['mcp'], `${path}: mcp`)
    onlyKnown(mcp, ['pin'], path, 'mcp.')
    if (Object.hasOwn(mcp, 'pin')) {
      const pin = mcp['pin']
      // A silent default here would mean the owner switched pinning off, it
      // stayed on, and held tools went unexplained — as for exposure.
      if (typeof pin !== 'boolean') throw new Error(`${path}: mcp.pin must be true or false, not ${String(pin)}`)
      policy.mcp = { pin }
    }
  }

  // The field is read as an own property: the policy file is parsed from
  // outside, and `__proto__` inside it must not look like a setting.
  if (Object.hasOwn(input, 'output')) {
    const output = asObject(input['output'], `${path}: output`)
    onlyKnown(output, ['footer'], path, 'output.')
    if (Object.hasOwn(output, 'footer')) {
      const footer = output['footer']
      // A silent default here would mean the human switched the footer off,
      // it stayed on, and they never learned about it.
      if (typeof footer !== 'boolean') {
        throw new Error(`${path}: output.footer must be true or false, not ${String(footer)}`)
      }
      policy.output.footer = footer
    }
  }

  return policy
}

/**
 * The journal path: absent, `~/…`, or absolute.
 *
 * The quickstart once wrote `file: ~/.cordon/events.jsonl` and nothing
 * expanded the tilde, so the journal landed in a directory literally named
 * `~` inside whatever project the agent ran in — not where the owner looked,
 * and one `git add .` from the repository. A relative path fails the same
 * way, against the working directory, so it stops the load.
 */
function journalPath(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${path}: notify.file must be a path, not ${String(value)}`)
  if (value === '~' || value.startsWith('~/')) return join(homedir(), value.slice(1))
  if (!isAbsolute(value)) {
    throw new Error(`${path}: notify.file must be an absolute path or start with ~/, not ${value}; a relative one lands in the project the agent runs in`)
  }
  return value
}

const TOP_LEVEL = [
  'mode', 'profile', 'tools', 'trustedSources', 'toolsReturn', 'arguments', 'destinations',
  'notify', 'exposure', 'task', 'memory', 'mcp', 'output',
]

/**
 * A key the loader does not know stops the load.
 *
 * Every field has a default, so a misspelled key would fall to it without a
 * word: `exposur: false` leaves the rule on, `memory: {fils: [...]}` leaves a
 * declared store unwatched, a misspelled `notify.file` leaves the owner
 * without the journal they read in the morning. The policy would not say what
 * its author believes, and nothing would show it — the same argument as for
 * notify.webhook. The keys under `tools` and `toolsReturn` are names the owner
 * chooses and are not checked here.
 */
function onlyKnown(object: Record<string, unknown>, known: readonly string[], path: string, prefix: string): void {
  for (const key of Object.keys(object)) {
    // notify.webhook has a refusal of its own that says more than this one.
    if (prefix === 'notify.' && key === 'webhook') continue
    if (!known.includes(key)) {
      throw new Error(`${path}: unknown key ${prefix}${key}; the keys here are ${known.join(', ')}`)
    }
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`)
  }
  return value as Record<string, unknown>
}

function asStrings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${where}: expected a list of strings`)
  }
  return value as string[]
}

/** A list of names in which an empty entry is a mistake, not a wildcard. */
function asNames(value: unknown, where: string): string[] {
  const list = asStrings(value, where)
  if (list.some((name) => name.trim() === '')) throw new Error(`${where}: an empty name cannot be a declaration`)
  return list
}

/**
 * The table of source-view declarations.
 *
 * Anything that is not one of the two known words is a load error, not a
 * skipped declaration. A silent default here would mean a policy that does
 * not do what it says: the human declared a tool as returning source,
 * mistyped the word, and Cordon went on cutting up their files. An empty
 * entry in the trusted-sources list once already made `/etc/passwd` trusted,
 * and there is no reason to repeat that way of failing.
 *
 * The table is built with a null prototype. Its keys come from the file, and
 * tool names chosen by an MCP server are later looked up against them: in a
 * table that inherited `Object.prototype`, the word `toString` would be a
 * ready-made declaration before the human declared anything at all.
 */
function asViews(value: unknown, where: string): Record<string, SourceView> {
  const input = asObject(value, where)
  const table: Record<string, SourceView> = Object.create(null) as Record<string, SourceView>

  for (const [tool, declared] of Object.entries(input)) {
    if (tool.trim() === '') {
      throw new Error(`${where}: an empty tool name cannot be a declaration`)
    }
    if (typeof declared !== 'string' || !VIEWS.has(declared)) {
      throw new Error(
        `${where}.${tool}: expected source or rendered, not ${String(declared)}`,
      )
    }
    table[tool] = declared as SourceView
  }

  return table
}

const ROLES: ReadonlySet<string> = new Set(['destination', 'resource', 'content'])

/** Null prototype, for the same reason as asViews: the keys come from the file. */
function asRoles(value: unknown, where: string): Record<string, Record<string, ArgumentRole>> {
  const input = asObject(value, where)
  const table = Object.create(null) as Record<string, Record<string, ArgumentRole>>
  for (const [tool, declared] of Object.entries(input)) {
    if (tool.trim() === '') throw new Error(`${where}: an empty tool name cannot be a declaration`)
    const fields = asObject(declared, `${where}.${tool}`)
    const roles = Object.create(null) as Record<string, ArgumentRole>
    for (const [name, role] of Object.entries(fields)) {
      if (typeof role !== 'string' || !ROLES.has(role)) {
        throw new Error(`${where}.${tool}.${name}: expected destination, resource or content, not ${String(role)}`)
      }
      roles[name] = role as ArgumentRole
    }
    table[tool] = roles
  }
  return table
}

function asEffects(value: unknown, where: string): EffectClass[] {
  const list = asStrings(value, where)
  for (const effect of list) {
    if (!EFFECTS.has(effect)) throw new Error(`${where}: unknown effect class ${effect}`)
  }
  return list as EffectClass[]
}
