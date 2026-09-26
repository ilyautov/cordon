import type { ArgumentRole, ToolCall } from './types.js'

/**
 * The argument names a call is read by, in one place.
 *
 * There were three copies of these lists — the gate and both adapters — and
 * they had already drifted apart. The gate knew `webhook` and the plurals,
 * the Gemini adapter knew `absolutepath` and neither of the others did, and
 * `filename` was in none of them while sitting in the list of names an MCP
 * result is parsed by. Three copies of a security rule means the next fix
 * lands in one of them, and the hole stays open in the other two.
 *
 * The names are folded before comparison: `file_path`, `filePath` and
 * `filepath` are one name chosen three ways by whoever wrote the server.
 */

/**
 * Arguments whose value is a path.
 *
 * `file` and `files` are deliberately absent. They hold a record as often as
 * a path — `{ file: { path, size } }` — and a value that is not a string
 * under a path name is a refusal in the gate, so adding them would turn an
 * ordinary tool into a permanently blocked one.
 */
export const PATH_KEYS: ReadonlySet<string> = new Set([
  'filepath', 'filepaths', 'path', 'paths', 'notebookpath', 'absolutepath',
  'targetpath', 'destination', 'dest', 'outputpath', 'filename', 'filenames',
])

/** Arguments whose value is a link. */
export const URL_KEYS: ReadonlySet<string> = new Set([
  'url', 'urls', 'uri', 'uris', 'href', 'link', 'links',
  'endpoint', 'webhook', 'baseurl', 'callbackurl',
])

/** Arguments whose value is executed by a shell. */
export const COMMAND_KEYS: ReadonlySet<string> = new Set(['command', 'cmd', 'script', 'shell'])

/**
 * Arguments that say where a call is aimed: the person, the channel, the
 * address. Only here does a name the user said count as a destination the
 * user named. An outside review found the name counted in any field: Bash's
 * `description: "Alice"` let a command through under the exposure mark.
 */
export const DESTINATION_KEYS: ReadonlySet<string> = new Set([
  'to', 'recipient', 'recipients', 'cc', 'bcc', 'user', 'users', 'username', 'userid',
  'member', 'members', 'channel', 'channels', 'channelname', 'chat', 'chatid', 'room',
  'conversation', 'email', 'emails', 'participants', 'assignee', 'assignees', 'reviewer', 'reviewers',
])

/**
 * Arguments that say which resource a call acts on. GitHub's MCP server was
 * led from an issue in a public repository into the user's private ones: every
 * call was a read or aimed at the repository the user named, and only the
 * resource changed. After an untrusted read, a resource the user did not name
 * escalates.
 */
export const RESOURCE_KEYS: ReadonlySet<string> = new Set([
  'repo', 'repository', 'repositories', 'repos',
  // The account a repository lives under: pacman named, owner switched to
  // another account, was a second route to someone else's private code.
  'owner', 'org', 'organization', 'namespace',
])

/** The role of an argument: the policy's declaration first, then the name. */
export function roleOf(
  tool: string,
  key: string,
  declared: Readonly<Record<string, Readonly<Record<string, ArgumentRole>>>>,
): ArgumentRole {
  const table = Object.hasOwn(declared, tool) ? declared[tool] : undefined
  if (table !== undefined && Object.hasOwn(table, key)) return table[key]!
  const folded = fold(key)
  if (DESTINATION_KEYS.has(folded)) return 'destination'
  if (RESOURCE_KEYS.has(folded)) return 'resource'
  return 'content'
}

/** One name out of the several spellings a server may have chosen. */
export function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
}

/**
 * The source's name: a link or a path from the call's arguments, and the tool
 * name when there are none.
 *
 * The tool name instead of a link looks like a harmless detail, but it kills
 * `trustedSources` entirely: the user declares a prefix like `/srv/docs`
 * trusted, and the word `Read` arrives for comparison, so the declaration
 * never matches. It also means the event log shows which document led to the
 * refusal instead of "Read".
 *
 * One copy for all four adapters: it decides which declared trusted source a
 * result counts as, and a rule that lived in an adapter would be a rule the
 * other transports do not have.
 *
 * Only top-level arguments are read. A label found deeper would let a call
 * carry a trusted link in a nested field beside the one it actually uses,
 * and the result would be classified by the decoy.
 */
export function sourceLabel(call: ToolCall): string {
  const args = Object.entries(call.args)
  for (const set of [URL_KEYS, PATH_KEYS]) {
    for (const [key, value] of args) {
      if (!set.has(fold(key))) continue
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return call.tool
}
