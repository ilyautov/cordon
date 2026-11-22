import { execFileSync } from 'node:child_process'
import { parseMergeProfile, validateTarget, type MergeProfile, type PrTarget } from './store.js'

type Read = (endpoint: string) => unknown

function github(endpoint: string): unknown {
  try {
    return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json', endpoint], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch {
    throw new Error('could not verify GitHub head or status')
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function verifyMergeHead(target: PrTarget, profile: MergeProfile, read: Read = github): void {
  validateTarget(target)
  parseMergeProfile(profile)
  if (target.baseRef !== profile.baseRef) throw new Error('unreviewed merge destination')
  const commit = record(read(`repos/${target.repo}/git/commits/${target.headSha}`))
  const parents = commit?.['parents']
  if (commit?.['sha'] !== target.headSha || !Array.isArray(parents) || parents.length !== 1 ||
    record(parents[0])?.['sha'] !== target.baseSha) {
    throw new Error('reviewed head must be one commit directly on the reviewed base')
  }

  const app = record(read(`apps/${profile.statusAppSlug}`))
  if (app?.['id'] !== profile.statusAppId || app?.['slug'] !== profile.statusAppSlug) {
    throw new Error('could not verify the required status App')
  }
  const statuses = read(`repos/${target.repo}/commits/${target.headSha}/statuses?per_page=100`)
  if (!Array.isArray(statuses)) throw new Error('invalid GitHub head statuses')
  // GitHub orders statuses newest first and treats contexts as case-insensitive.
  const context = profile.statusContext.toLowerCase()
  const latest = record(statuses.find((item) => {
    const name = record(item)?.['context']
    return typeof name === 'string' && name.toLowerCase() === context
  }))
  const actor = record(latest?.['creator'])
  if (latest?.['state'] !== 'success' || actor?.['type'] !== 'Bot' ||
    actor?.['login'] !== `${profile.statusAppSlug}[bot]`) {
    throw new Error('the required GitHub App status on the reviewed head is missing or unsuccessful')
  }
}
