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

/** One name out of the several spellings a server may have chosen. */
export function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/gu, '')
}
