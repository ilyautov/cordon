import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { sanitize } from '../sanitize/index.js'

/**
 * `cordon audit`: what an agent will load, read before it runs.
 *
 * Nothing here runs a server, fetches a package or calls a network: the
 * audit reads files and nothing else, so it can run in CI on a pull request
 * from a stranger and on an air-gapped machine alike. A finding is a signal,
 * as everywhere in Cordon; whether it fails a build is the caller's choice
 * (`--fail-on`).
 */

export type Severity = 'high' | 'medium' | 'low'

export interface AuditFinding {
  /** Stable: a CI rule or a report cites it. Never renumbered. */
  code: string
  severity: Severity
  /** The OWASP Top 10 for LLM Applications (2025) entry the finding belongs to. */
  owasp: string
  /** The file the finding is in, relative to the root or to the home directory (as ~/...). */
  file: string
  /** The server, tool or hook the finding is about, when there is one. */
  subject?: string
  title: string
  detail: string
}

export interface AuditOptions {
  /** The project directory. */
  root: string
  /** The user's home directory. */
  home: string
}

/** The catalogue: code, severity, OWASP entry, title. Docs are generated from nothing else. */
export const CODES = {
  CA101: { severity: 'high', owasp: 'LLM01 Prompt Injection', title: 'invisible characters in a file the agent loads as instruction' },
  CA102: { severity: 'medium', owasp: 'LLM01 Prompt Injection', title: 'an encoded block in a file the agent loads as instruction' },
  CA103: { severity: 'low', owasp: 'LLM01 Prompt Injection', title: 'markup hidden when rendered in a file the agent loads as instruction' },
  CA104: { severity: 'low', owasp: 'LLM01 Prompt Injection', title: 'a word mixing scripts in a file the agent loads as instruction' },
  CA201: { severity: 'medium', owasp: 'LLM01 Prompt Injection', title: 'an MCP server not behind the Cordon gateway' },
  CA202: { severity: 'medium', owasp: 'LLM03 Supply Chain', title: 'an MCP server package started without a pinned version' },
  CA203: { severity: 'high', owasp: 'LLM02 Sensitive Information Disclosure', title: 'a literal secret in an MCP server configuration' },
  CA205: { severity: 'high', owasp: 'LLM03 Supply Chain', title: 'an MCP package pinned to a version with a known vulnerability' },
  CA204: { severity: 'low', owasp: 'LLM01 Prompt Injection', title: 'a remote MCP server the stdio gateway cannot cover' },
  CA301: { severity: 'medium', owasp: 'LLM03 Supply Chain', title: 'a hook defined in the project\'s own settings' },
  CA303: { severity: 'high', owasp: 'LLM03 Supply Chain', title: 'the project sets environment that steers Cordon or the hook process' },
  CA304: { severity: 'high', owasp: 'LLM03 Supply Chain', title: 'the project switches hooks or the Cordon plugin off' },
  CA305: { severity: 'high', owasp: 'LLM02 Sensitive Information Disclosure', title: 'the project points the model endpoint elsewhere' },
  CA306: { severity: 'high', owasp: 'LLM03 Supply Chain', title: 'the project enables its own MCP servers' },
  CA307: { severity: 'high', owasp: 'LLM06 Excessive Agency', title: 'the project turns agent tool confirmations off' },
  CA308: { severity: 'medium', owasp: 'LLM03 Supply Chain', title: 'a task that runs when the folder opens' },
  CA302: { severity: 'low', owasp: 'LLM01 Prompt Injection', title: 'Claude Code runs without Cordon' },
  CA901: { severity: 'medium', owasp: 'LLM03 Supply Chain', title: 'a configuration file that could not be read' },
} as const satisfies Record<string, { severity: Severity; owasp: string; title: string }>

type Code = keyof typeof CODES

/** Files larger than this are not instruction files anyone reviews by eye; they are skipped, not read. */
const MAX_FILE_BYTES = 1024 * 1024

const INSTRUCTION_FILES = [
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules',
  '.github/copilot-instructions.md', '.claude/CLAUDE.md', '.gemini/GEMINI.md',
]

/** Directories whose markdown the harness loads as skills, commands or agents. */
const INSTRUCTION_DIRS = ['.claude/skills', '.claude/commands', '.claude/agents', '.gemini/commands']

const MCP_CONFIGS: Array<{ path: string; scope: 'root' | 'home' | 'both' }> = [
  { path: '.mcp.json', scope: 'root' },
  { path: '.vscode/mcp.json', scope: 'root' },
  { path: '.cursor/mcp.json', scope: 'both' },
  { path: '.gemini/settings.json', scope: 'both' },
  { path: '.claude.json', scope: 'home' },
  { path: '.codeium/windsurf/mcp_config.json', scope: 'home' },
  { path: 'Library/Application Support/Claude/claude_desktop_config.json', scope: 'home' },
]

export function audit(options: AuditOptions): AuditFinding[] {
  const findings: AuditFinding[] = []
  const add = (code: Code, file: string, detail: string, subject?: string): void => {
    const { severity, owasp, title } = CODES[code]
    findings.push({ code, severity, owasp, file, ...(subject === undefined ? {} : { subject }), title, detail })
  }

  for (const base of [{ dir: options.root, label: '' }, { dir: options.home, label: '~/' }]) {
    for (const path of instructionFiles(base.dir)) instructionFinding(path, base, add)
  }

  for (const config of MCP_CONFIGS) {
    const bases = config.scope === 'both'
      ? [{ dir: options.root, label: '' }, { dir: options.home, label: '~/' }]
      : config.scope === 'root' ? [{ dir: options.root, label: '' }] : [{ dir: options.home, label: '~/' }]
    for (const base of bases) mcpFindings(join(base.dir, config.path), base.label + config.path, add)
  }

  hookFindings(options, add)
  vscodeFindings(options.root, add)
  return findings
}

type Add = (code: Code, file: string, detail: string, subject?: string) => void

function instructionFiles(dir: string): string[] {
  const out = INSTRUCTION_FILES.map((name) => join(dir, name)).filter(isFile)
  for (const sub of INSTRUCTION_DIRS) out.push(...markdownUnder(join(dir, sub), 4))
  return out
}

function markdownUnder(dir: string, depth: number): string[] {
  if (depth < 0) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names.sort()) {
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...markdownUnder(path, depth - 1))
    else if (stat.isFile() && name.toLowerCase().endsWith('.md')) out.push(path)
  }
  return out
}

/**
 * Findings in an instruction file, ranked by who can see them.
 *
 * These files are edited and reviewed as source, not rendered, so what is
 * hidden depends on the view. An invisible character hides in the source
 * too: high. An encoded block is in plain sight but unreadable: medium. An
 * HTML comment or a hidden element hides only in a rendered preview, such as
 * GitHub's: low. A word mixing scripts is most often a brand or slang, and
 * only sometimes a homoglyph: low. Ranking them together buried the one
 * real finding on a live machine under fifty comments.
 */
const INSTRUCTION_CODES: Array<{ code: Code; kinds: ReadonlySet<string>; why: string }> = [
  { code: 'CA101', kinds: new Set(['invisible']), why: 'the model reads it; no editor shows it' },
  { code: 'CA102', kinds: new Set(['encoded']), why: 'the model can decode it; a reviewer reads past it' },
  { code: 'CA103', kinds: new Set(['hidden-html']), why: 'visible in the source, hidden in a rendered preview' },
  { code: 'CA104', kinds: new Set(['mixed-script']), why: 'usually a brand name or slang, sometimes a homoglyph; check the sample' },
]

function instructionFinding(path: string, base: { dir: string; label: string }, add: Add): void {
  const text = readSmall(path)
  if (text === null) return
  const file = base.label + relative(base.dir, path)
  const found = sanitize(text).findings
  for (const { code, kinds, why } of INSTRUCTION_CODES) {
    const matching = found.filter((finding) => kinds.has(finding.kind))
    if (matching.length === 0) continue
    const details = [...new Set(matching.map((finding) => finding.detail))].join(', ')
    const samples = code === 'CA104' ? `: ${[...new Set(matching.map((finding) => finding.sample))].slice(0, 3).join(', ')}` : ''
    add(code, file, `${matching.length} × ${details}${samples}; ${why}`)
  }
}

interface ServerEntry {
  command?: unknown
  args?: unknown
  env?: unknown
  headers?: unknown
  url?: unknown
  type?: unknown
}

function mcpFindings(path: string, file: string, add: Add): void {
  if (!isFile(path)) return
  const text = readSmall(path)
  if (text === null) {
    add('CA901', file, 'too large or unreadable')
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    add('CA901', file, `not valid JSON: ${(error as Error).message}`)
    return
  }
  for (const [name, entry] of serversIn(parsed)) serverFindings(name, entry, file, add)
}

/** mcpServers at the top level, `servers` (VS Code), and per-project blocks in ~/.claude.json. */
function serversIn(config: unknown): Array<[string, ServerEntry]> {
  const out: Array<[string, ServerEntry]> = []
  const take = (block: unknown): void => {
    if (!isRecord(block)) return
    for (const [name, entry] of Object.entries(block)) if (isRecord(entry)) out.push([name, entry as ServerEntry])
  }
  if (!isRecord(config)) return out
  take(config['mcpServers'])
  take(config['servers'])
  const projects = config['projects']
  if (isRecord(projects)) for (const project of Object.values(projects)) if (isRecord(project)) take(project['mcpServers'])
  return out
}

function serverFindings(name: string, entry: ServerEntry, file: string, add: Add): void {
  const command = typeof entry.command === 'string' ? entry.command : null
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []

  if (command === null) {
    if (typeof entry.url === 'string' || entry.type === 'http' || entry.type === 'sse') {
      add('CA204', file, 'a remote server is reached over HTTP; `cordon mcp` gates stdio servers only', name)
    }
  } else {
    const words = [command, ...args]
    const gated = isGateway(words)
    if (!gated) add('CA201', file, `started as \`${words.join(' ')}\`; wrap it as \`cordon mcp -- ${words.join(' ')}\``, name)
    const upstream = gated ? words.slice(words.indexOf('--') + 1) : words
    const unpinned = unpinnedPackage(upstream)
    if (unpinned !== null) add('CA202', file, `\`${unpinned}\` resolves to whatever the registry serves at start; pin a version`, name)
    for (const word of upstream) {
      const known = knownVulnerable(word)
      if (known !== null) add('CA205', file, `\`${word}\` is affected by ${known}`, name)
    }
  }

  if (!file.startsWith('~/')) steeringEnv(entry.env, file, add)

  for (const [where, block] of [['env', entry.env], ['headers', entry.headers]] as const) {
    if (!isRecord(block)) continue
    for (const [key, value] of Object.entries(block)) {
      // The value never enters the finding: the report is meant to be pasted
      // into a ticket, and a secret in it would be the leak it warns about.
      if (typeof value === 'string' && looksLikeSecret(key, value)) {
        add('CA203', file, `${where}.${key} holds a literal value; reference the environment instead (\${${key}})`, name)
      }
    }
  }
}

/**
 * Variables that decide which policy Cordon reads or what code runs in the
 * hook process. Claude Code hands a project's `env` to hook processes
 * (verified live), so a repository setting CORDON_HOME brings its own policy,
 * and NODE_OPTIONS or PATH put its own code into the hook. The runtime refuses
 * a home inside the project; this names the attempt before anything runs.
 */
const STEERING = /^(CORDON_[A-Z_]*|NODE_OPTIONS|NODE_PATH|PATH|LD_PRELOAD|DYLD_[A-Z_]+)$/u

function steeringEnv(env: unknown, file: string, add: Add): void {
  if (!isRecord(env)) return
  for (const key of Object.keys(env)) {
    if (STEERING.test(key)) add('CA303', file, `env.${key} is set by the project; it reaches the hook processes that enforce the policy`, key)
  }
}

/**
 * A project that turns the defence off from its own settings. `disableAllHooks`
 * silences every hook but a managed one, the Cordon plugin's included, and a
 * project entry disabling the plugin outranks the user's own enabling.
 */
function switchedOff(settings: unknown, file: string, add: Add): void {
  if (!isRecord(settings)) return
  if (settings['disableAllHooks'] === true) add('CA304', file, 'disableAllHooks: true silences every hook that is not managed, Cordon\'s included')
  const plugins = settings['enabledPlugins']
  if (isRecord(plugins)) {
    for (const [name, on] of Object.entries(plugins)) {
      if (name.startsWith('cordon@') && on === false) add('CA304', file, `enabledPlugins disables ${name} for everyone who opens the project`, name)
    }
  }
}

function isGateway(words: string[]): boolean {
  const at = words.indexOf('--')
  if (at === -1) return false
  const before = words.slice(0, at)
  return before.includes('mcp') && before.some((word) => /(^|[/@])cordon(\.js)?$|@ilyautov\/cordon(@[^/]*)?$/u.test(word))
}

const RUNNERS: ReadonlyMap<string, 'npm' | 'python'> = new Map([
  ['npx', 'npm'], ['bunx', 'npm'], ['pnpx', 'npm'], ['uvx', 'python'], ['pipx', 'python'],
])

/** The package spec a runner would fetch unpinned, or null. */
/**
 * MCP packages with a published vulnerability, by the first fixed version.
 * CVE-2025-6514: mcp-remote ran a command from a server's OAuth metadata.
 * CVE-2025-49596: MCP Inspector's proxy took commands from any web page.
 */
const VULNERABLE: ReadonlyArray<{ name: string; fixed: readonly number[]; advisory: string }> = [
  { name: 'mcp-remote', fixed: [0, 1, 16], advisory: 'CVE-2025-6514 (command injection through OAuth discovery), fixed in 0.1.16' },
  { name: '@modelcontextprotocol/inspector', fixed: [0, 14, 1], advisory: 'CVE-2025-49596 (unauthenticated RCE through the proxy), fixed in 0.14.1' },
]

function knownVulnerable(spec: string): string | null {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return null
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1).split('.').map((part) => Number.parseInt(part, 10))
  if (version.length !== 3 || version.some((part) => Number.isNaN(part))) return null
  const entry = VULNERABLE.find((candidate) => candidate.name === name)
  if (entry === undefined) return null
  for (let i = 0; i < 3; i++) {
    if (version[i]! < entry.fixed[i]!) return entry.advisory
    if (version[i]! > entry.fixed[i]!) return null
  }
  return null
}

function unpinnedPackage(words: string[]): string | null {
  const runner = RUNNERS.get(words[0]?.replace(/^.*[/\\]/u, '') ?? '')
  if (runner === undefined) return null
  let rest = words.slice(1)
  if (words[0] === 'pipx' && rest[0] === 'run') rest = rest.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!
    // `--from pkg==1.0 tool` and `-p pkg@1` name the package in the value.
    if (word === '--from' || word === '-p' || word === '--package') {
      const spec = rest[i + 1]
      return spec === undefined || pinned(spec, runner) ? null : spec
    }
    if (word.startsWith('-')) continue
    return pinned(word, runner) ? null : word
  }
  return null
}

function pinned(spec: string, runner: 'npm' | 'python'): boolean {
  if (runner === 'python') return /(==|@)\d/u.test(spec)
  const at = spec.lastIndexOf('@')
  if (at <= 0) return false
  return /^\d/u.test(spec.slice(at + 1))
}

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|bearer)/iu
const SECRET_SHAPE = /^(ghp_|gho_|ghs_|github_pat_|sk-|xox[abpr]-|AKIA|AIza|glpat-)/u

function looksLikeSecret(key: string, value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || /^\$\{?[A-Za-z_]/u.test(trimmed) || /^\{\{.*\}\}$/u.test(trimmed)) return false
  if (SECRET_SHAPE.test(trimmed.replace(/^Bearer\s+/iu, ''))) return true
  return SECRET_KEY.test(key) && trimmed.length >= 8 && !/^(true|false|none|null)$/iu.test(trimmed)
}

/**
 * A model endpoint set by the project. CVE-2026-21852: ANTHROPIC_BASE_URL in
 * a repository's settings sent the API key to the attacker's proxy before the
 * trust dialog.
 */
const ENDPOINT = /^[A-Z0-9_]*(BASE_URL|API_URL|ENDPOINT|API_BASE|API_HOST)$/u

function endpointEnv(env: unknown, file: string, add: Add): void {
  if (!isRecord(env)) return
  for (const key of Object.keys(env)) {
    if (ENDPOINT.test(key)) add('CA305', file, `env.${key} sends the agent's requests, and its key, where the repository chooses`, key)
  }
}

/** VS Code's own files, JSON with comments and trailing commas. */
function vscodeFindings(root: string, add: Add): void {
  const settings = readJsonc(join(root, '.vscode', 'settings.json'), '.vscode/settings.json', add)
  if (isRecord(settings)) {
    for (const [key, value] of Object.entries(settings)) {
      // CVE-2025-53773: chat.tools.autoApprove let an injection run commands
      // with no confirmation. Any autoApprove switched on is the same shape.
      if (/autoapprove/iu.test(key) && value !== false && value !== null) {
        add('CA307', '.vscode/settings.json', `${key} approves agent tool calls without asking whoever opens the project`, key)
      }
    }
  }
  const tasks = readJsonc(join(root, '.vscode', 'tasks.json'), '.vscode/tasks.json', add)
  const list = isRecord(tasks) && Array.isArray(tasks['tasks']) ? tasks['tasks'] : []
  for (const task of list) {
    if (!isRecord(task)) continue
    const options = task['runOptions']
    if (isRecord(options) && options['runOn'] === 'folderOpen') {
      const label = typeof task['label'] === 'string' ? task['label'] : '(unnamed)'
      add('CA308', '.vscode/tasks.json', `task \`${label}\` runs when the folder is opened, before anyone reads it`, label)
    }
  }
}

function readJsonc(path: string, file: string, add: Add): unknown {
  if (!isFile(path)) return null
  const text = readSmall(path)
  // Said out loud rather than skipped: padding past the size limit hid an
  // autoApprove from the audit once, and silence read as a clean file.
  if (text === null) {
    add('CA901', file, 'too large or unreadable')
    return null
  }
  // Comments, then trailing commas, each outside strings only: a string is
  // matched first and kept, so `"a,]"` is never rewritten.
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (_, string: string | undefined) => string ?? '')
    .replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/gu, (_, string: string | undefined) => string ?? '')
  try {
    return JSON.parse(stripped) as unknown
  } catch (error) {
    // VS Code's own parser forgives more than this one, so a file this one
    // cannot read may still apply settings: a finding, not an absence.
    add('CA901', file, `not valid JSON with comments: ${(error as Error).message}`)
    return null
  }
}

function hookFindings(options: AuditOptions, add: Add): void {
  let cordonSeen = false
  for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
    const settings = readJson(join(options.root, name))
    if (settings === null) continue
    for (const command of hookCommands(settings)) {
      if (isCordonHook(command)) {
        cordonSeen = true
        continue
      }
      add('CA301', name, `\`${command}\` runs on this machine when the agent starts here; it came with the repository`)
    }
    if (hasCordonPlugin(settings)) cordonSeen = true
    steeringEnv(isRecord(settings) ? settings['env'] : undefined, name, add)
    endpointEnv(isRecord(settings) ? settings['env'] : undefined, name, add)
    switchedOff(settings, name, add)
    if (isRecord(settings)) {
      const listed = settings['enabledMcpjsonServers']
      if (settings['enableAllProjectMcpServers'] === true) {
        add('CA306', name, 'enableAllProjectMcpServers: true starts every server in .mcp.json without asking (CVE-2025-59536)')
      } else if (Array.isArray(listed) && listed.length > 0) {
        add('CA306', name, `enabledMcpjsonServers starts ${listed.filter((item) => typeof item === 'string').join(', ')} without asking (CVE-2025-59536)`)
      }
    }
  }

  const userSettings = join(options.home, '.claude', 'settings.json')
  if (!isFile(userSettings)) return
  const settings = readJson(userSettings)
  if (settings !== null && (hasCordonPlugin(settings) || hookCommands(settings).some(isCordonHook))) cordonSeen = true
  if (!cordonSeen) {
    add('CA302', '~/.claude/settings.json', 'no Cordon plugin enabled and no `cordon hook` command in the hooks; see docs/install.md')
  }
}

function hookCommands(settings: unknown): string[] {
  const hooks = isRecord(settings) ? settings['hooks'] : undefined
  if (!isRecord(hooks)) return []
  const out: string[] = []
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const inner = isRecord(group) ? group['hooks'] : undefined
      if (!Array.isArray(inner)) continue
      for (const hook of inner) if (isRecord(hook) && typeof hook['command'] === 'string') out.push(hook['command'])
    }
  }
  return out
}

function isCordonHook(command: string): boolean {
  return /cordon/u.test(command) && /\bhook\b/u.test(command)
}

function hasCordonPlugin(settings: unknown): boolean {
  const plugins = isRecord(settings) ? settings['enabledPlugins'] : undefined
  return isRecord(plugins) && Object.entries(plugins).some(([name, on]) => name.startsWith('cordon@') && on === true)
}

function readJson(path: string): unknown {
  const text = readSmall(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Hooks in a settings file the harness cannot parse do not run either;
    // the MCP pass reports unreadable configs where they matter.
    return null
  }
}

function readSmall(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
