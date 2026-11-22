import { execFileSync } from 'node:child_process'
import { parse } from 'node:path'
import { validatePrSelection, validateTarget, type PrTarget } from './store.js'

export type PullSnapshot = PrTarget & { title: string; body: string }
export type GitHubRead = (endpoint: string, accept: string) => Buffer

const jsonMedia = 'application/vnd.github+json'
const diffMedia = 'application/vnd.github.diff'
const maxBytes = 4 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function readGitHub(endpoint: string, accept: string): Buffer {
  try {
    return execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', `Accept: ${accept}`, endpoint], { timeout: 15_000, maxBuffer: maxBytes, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new Error('GitHub read failed')
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function decode(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('empty or oversized GitHub response')
  return decoder.decode(bytes)
}

function readJson(endpoint: string, read: GitHubRead): Record<string, unknown> {
  const text = decode(read(endpoint, jsonMedia))
  try {
    const value = object(JSON.parse(text))
    if (value !== undefined) return value
  } catch {
    // Do not include a GitHub response body in protocol errors.
  }
  throw new Error('invalid GitHub JSON response')
}

function refSha(repo: string, ref: string, read: GitHubRead): string {
  const path = ref.split('/').map(encodeURIComponent).join('/')
  const response = readJson(`repos/${repo}/git/ref/${path}`, read)
  const commit = object(response['object'])
  const sha = commit?.['sha']
  if (response['ref'] !== `refs/${ref}` || commit?.['type'] !== 'commit' ||
    typeof sha !== 'string' || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error('invalid GitHub commit ref')
  return sha
}

export function getPullSnapshot(repo: string, number: number, read: GitHubRead = readGitHub): PullSnapshot {
  validatePrSelection(repo, number)
  const response = readJson(`repos/${repo}/pulls/${number}`, read)
  const base = object(response['base'])
  const baseRepo = object(base?.['repo'])?.['full_name']
  const baseRef = base?.['ref']
  const baseSha = base?.['sha']
  const headSha = object(response['head'])?.['sha']
  const title = response['title']
  const body = response['body']
  if (response['number'] !== number || response['state'] !== 'open' ||
    typeof baseRepo !== 'string' || baseRepo.toLowerCase() !== repo.toLowerCase() ||
    typeof baseRef !== 'string' || typeof baseSha !== 'string' || typeof headSha !== 'string' ||
    typeof title !== 'string' || (typeof body !== 'string' && body !== null)) {
    throw new Error('invalid or closed GitHub PR snapshot')
  }
  const target = { repo, number, baseRef, baseSha, headSha }
  validateTarget(target)
  // The pull resource can retain its earlier base SHA after the branch advances.
  const liveBase = refSha(repo, `heads/${baseRef}`, read)
  if (refSha(repo, `pull/${number}/head`, read) !== headSha) throw new Error('GitHub PR head ref changed')
  return { ...target, baseSha: liveBase, title, body: body ?? '' }
}

type ChangedFile = { additions: number; deletions: number; patch: string }

function changedFiles(endpoint: string, target: PrTarget, read: GitHubRead): Map<string, ChangedFile> {
  const summary = readJson(`${endpoint}?per_page=1`, read)
  const files = summary['files']
  // GitHub caps the first page's file list at 300 for the whole comparison.
  // A response at the cap does not establish that the list is complete.
  if (object(summary['base_commit'])?.['sha'] !== target.baseSha ||
    !Array.isArray(files) || files.length === 0 || files.length >= 300) {
    throw new Error('empty or incomplete GitHub comparison')
  }
  const expected = new Map<string, ChangedFile>()
  for (const value of files) {
    const file = object(value)
    const filename = file?.['filename']
    const additions = file?.['additions']
    const deletions = file?.['deletions']
    const patch = file?.['patch']
    if (typeof filename !== 'string' || filename === '' || expected.has(filename) ||
      typeof additions !== 'number' || !Number.isSafeInteger(additions) || additions < 0 ||
      typeof deletions !== 'number' || !Number.isSafeInteger(deletions) || deletions < 0 ||
      (patch !== undefined && typeof patch !== 'string') ||
      (additions + deletions > 0 && (patch === undefined || patch === ''))) {
      throw new Error('incomplete GitHub comparison file metadata')
    }
    expected.set(filename, { additions, deletions, patch: (patch ?? '').replace(/\n$/u, '') })
  }
  return expected
}

const fileHeader = /^(?:(?:old|new|new file|deleted file) mode [0-7]{6}|index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]{6})?|(?:dis)?similarity index \d+%|(?:rename|copy) (?:from|to) .+|--- .+|\+\+\+ .+)$/u

function textPatches(diff: string): string[] {
  if (!diff.startsWith('diff --git ') || !diff.endsWith('\n') || diff.includes('\0')) {
    throw new Error('invalid GitHub diff framing')
  }
  return diff.slice(0, -1).split(/\n(?=diff --git )/u).map((section) => {
    const start = section.indexOf('\n@@ ')
    const header = start < 0 ? section : section.slice(0, start)
    const lines = header.split('\n').slice(1)
    if (lines.length === 0 || lines.some((line) => !fileHeader.test(line))) {
      throw new Error('invalid or unsupported GitHub diff header')
    }
    return start < 0 ? '' : section.slice(start + 1)
  })
}

function diffStats(bytes: Buffer): string[] {
  try {
    // --numstat only parses the patch. It never applies it or opens its paths.
    // In a repository subdirectory, Git silently skips paths outside that directory.
    const output = execFileSync('git', ['apply', '--numstat', '-z', '--whitespace=nowarn', '-'], {
      cwd: parse(process.cwd()).root, input: bytes, timeout: 5_000,
      maxBuffer: maxBytes, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const text = decode(output)
    if (text.endsWith('\0')) return text.slice(0, -1).split('\0')
  } catch {
    // Invalid or unsupported patch data is never evidence of a complete diff.
  }
  throw new Error('could not validate GitHub diff')
}

export function getPinnedDiff(target: PrTarget, read: GitHubRead = readGitHub): string {
  validateTarget(target)
  const endpoint = `repos/${target.repo}/compare/${target.baseSha}...${target.headSha}`
  const expected = changedFiles(endpoint, target, read)
  const bytes = read(endpoint, diffMedia)
  const diff = decode(bytes)
  const patches = textPatches(diff)
  const stats = diffStats(bytes)
  if (stats.length !== expected.size || patches.length !== stats.length) {
    throw new Error('incomplete GitHub diff')
  }
  for (const [index, stat] of stats.entries()) {
    const fields = /^(\d+)\t(\d+)\t([\s\S]+)$/u.exec(stat)
    const filename = fields?.[3]
    const file = filename === undefined ? undefined : expected.get(filename)
    if (fields === null || filename === undefined || file === undefined ||
      Number(fields[1]) !== file.additions || Number(fields[2]) !== file.deletions || patches[index] !== file.patch) {
      throw new Error('GitHub diff and comparison metadata disagree')
    }
    expected.delete(filename)
  }
  return diff
}
