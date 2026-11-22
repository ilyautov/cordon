import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { canonical } from '../core/canonical.js'
import { parseMergeProfile, validateTarget, type MergePolicyEvidence, type MergeProfile, type PrTarget } from './store.js'

type ReadOptions = { paginate?: boolean; unprotected?: boolean }
export type MergePolicyRead = (endpoint: string, options?: ReadOptions) => unknown
type JsonObject = Record<string, unknown>
type Rule = { type: string; parameters?: JsonObject }
type Ruleset = {
  identity: JsonObject
  id: number
  active: boolean
  target: string
  conditions: unknown
  rules: Rule[]
  bypass: JsonObject[]
  callerBypass: unknown
}

const pageSize = 100

function object(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function absentClassicProtection(error: unknown): boolean {
  const failure = error as { stdout?: unknown; stderr?: unknown } | null
  if (typeof failure?.stdout !== 'string' || typeof failure.stderr !== 'string' ||
    !failure.stderr.includes('(HTTP 404)')) return false
  try {
    return object(JSON.parse(failure.stdout))?.['message'] === 'Branch not protected'
  } catch {
    return false
  }
}

function readGitHub(endpoint: string, options?: ReadOptions): unknown {
  const paging = options?.paginate ? ['--paginate', '--slurp'] : []
  try {
    const body = execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json', ...paging, endpoint], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(body)
  } catch (error) {
    // A generic 404 can mean hidden data. Only the explicit unprotected
    // response is compatible with proving the classic policy was inspected.
    if (options?.unprotected && absentClassicProtection(error)) return null
    throw new Error('could not inspect GitHub repository rules')
  }
}

function pages(response: unknown, label: string): unknown[] {
  if (!Array.isArray(response) || response.length === 0 || response.length > 5 ||
    response.some((page, index) => !Array.isArray(page) ||
      (index < response.length - 1 ? page.length !== pageSize : page.length >= pageSize))) {
    throw new Error(`could not enumerate complete GitHub ${label}`)
  }
  return response.flat()
}

function strings(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => value[index] === item)
}

function canonicalOrder(values: readonly unknown[]): string[] {
  return values.map(canonical).sort()
}

function sameRepo(value: unknown, repo: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === repo.toLowerCase()
}

function identity(row: JsonObject | undefined, repo: string): JsonObject {
  const updated = row?.['updated_at']
  if (!positiveId(row?.['id']) || row?.['source_type'] !== 'Repository' || !sameRepo(row['source'], repo) ||
    !['active', 'disabled', 'evaluate'].some((value) => value === row['enforcement']) ||
    typeof updated !== 'string' || !Number.isFinite(Date.parse(updated))) {
    throw new Error('unverified GitHub repository ruleset identity')
  }
  return { id: row['id'], source: repo.toLowerCase(), source_type: 'Repository',
    enforcement: row['enforcement'], updated_at: new Date(updated).toISOString() }
}

function readListing(endpoint: string, repo: string, read: MergePolicyRead): JsonObject[] {
  const entries: JsonObject[] = pages(read(endpoint, { paginate: true }), 'rulesets').map((item) => {
    const row = object(item)
    const key = identity(row, repo)
    return { ...key, name: row?.['name'], target: row?.['target'], node_id: row?.['node_id'] }
  })
  if (new Set(entries.map((entry) => entry['id'])).size !== entries.length) {
    throw new Error('duplicate GitHub ruleset identity')
  }
  return entries
}

function rule(value: unknown): Rule {
  const row = object(value)
  const type = row?.['type']
  const parameters = row?.['parameters']
  if (typeof type !== 'string' || type === '' ||
    (parameters !== undefined && parameters !== null && object(parameters) === undefined)) {
    throw new Error('invalid GitHub rule')
  }
  return { type, parameters: object(parameters) }
}

function bypassActors(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('GitHub ruleset bypass actors are not visible')
  return value.map((actor) => {
    const row = object(actor)
    if (row === undefined || typeof row['actor_type'] !== 'string' ||
      typeof row['bypass_mode'] !== 'string' || (!positiveId(row['actor_id']) && row['actor_id'] !== null)) {
      throw new Error('invalid GitHub bypass actor')
    }
    return row
  })
}

function readRuleset(prefix: string, repo: string, listed: JsonObject, read: MergePolicyRead): Ruleset {
  const id = listed['id'] as number
  const row = object(read(`${prefix}/rulesets/${id}`))
  const key = identity(row, repo)
  const target = row?.['target']
  if (row === undefined || Object.keys(key).some((field) => key[field] !== listed[field]) ||
    ['name', 'target', 'node_id'].some((field) => listed[field] !== undefined && listed[field] !== row[field]) ||
    typeof target !== 'string' || !Array.isArray(row['rules']) || !Object.hasOwn(row, 'conditions')) {
    throw new Error('GitHub ruleset changed or is incomplete')
  }
  return { identity: { ...key, target, node_id: row['node_id'], name: row['name'] },
    id, target, active: row['enforcement'] === 'active', conditions: row['conditions'], rules: row['rules'].map(rule),
    bypass: bypassActors(row['bypass_actors']), callerBypass: row['current_user_can_bypass'] }
}

function exactScope(ruleset: Ruleset, include: string, exclude: string[]): boolean {
  const conditions = object(ruleset.conditions)
  const ref = object(conditions?.['ref_name'])
  return ruleset.active && ruleset.target === 'branch' && conditions !== undefined &&
    Object.keys(conditions).length === 1 && ref !== undefined && Object.keys(ref).length === 2 &&
    strings(ref['include'], [include]) && strings(ref['exclude'], exclude)
}

function ownerBypassOnly(ruleset: Ruleset, ownerId: number): boolean {
  const [actor] = ruleset.bypass
  if (actor === undefined) {
    return ruleset.callerBypass === undefined || ruleset.callerBypass === 'never'
  }
  return ruleset.bypass.length === 1 && Object.keys(actor).length === 3 &&
    actor['actor_type'] === 'User' && actor['actor_id'] === ownerId &&
    (actor['bypass_mode'] === 'always' || actor['bypass_mode'] === 'pull_request')
}

function statusChecks(candidate: Rule): JsonObject[] {
  if (candidate.type !== 'required_status_checks') return []
  const checks = candidate.parameters?.['required_status_checks']
  if (!Array.isArray(checks)) throw new Error('invalid effective GitHub required status checks')
  return checks.map((value) => {
    const check = object(value)
    if (typeof check?.['context'] !== 'string' || check['context'] === '') {
      throw new Error('invalid effective GitHub required status check')
    }
    return check
  })
}

function sameStatusContext(check: JsonObject, profile: MergeProfile): boolean {
  return String(check['context']).toLowerCase() === profile.statusContext.toLowerCase()
}

function strictCheck(candidate: Rule, profile: MergeProfile): boolean {
  const config = candidate.parameters
  if (candidate.type !== 'required_status_checks' || !config ||
    config['strict_required_status_checks_policy'] !== true ||
    (config['do_not_enforce_on_create'] !== undefined && config['do_not_enforce_on_create'] !== false)) return false
  const matches = statusChecks(candidate).filter((check) => sameStatusContext(check, profile))
  return matches.length === 1 && matches[0]?.['context'] === profile.statusContext &&
    matches[0]['integration_id'] === profile.statusAppId
}

function simpleRule(rules: Rule[], type: string): boolean {
  return rules.some((rule) => rule.type === type &&
    (rule.parameters === undefined || Object.keys(rule.parameters).length === 0))
}

function activeRules(response: unknown, rulesets: Ruleset[], repo: string): Map<number, Rule[]> {
  const byId = new Map(rulesets.map((set) => [set.id, set]))
  const matched = new Map<number, Rule[]>()
  for (const value of pages(response, 'effective branch rules')) {
    const row = object(value)
    const id = row?.['ruleset_id']
    if (!positiveId(id) || !byId.get(id)?.active || row?.['ruleset_source_type'] !== 'Repository' ||
      !sameRepo(row['ruleset_source'], repo)) {
      throw new Error('unverified effective GitHub branch rule')
    }
    const parsed = rule(row)
    const group = matched.get(id) ?? []
    group.push(parsed)
    matched.set(id, group)
  }
  return matched
}

function assertGuards(
  rulesets: Ruleset[], effective: Map<number, Rule[]>, ownRef: string, ownerId: number, profile: MergeProfile,
): void {
  const appliedChecks = [...effective.values()].flatMap((rules) => rules.flatMap(statusChecks))
  if (appliedChecks.some((check) => sameStatusContext(check, profile) && check['integration_id'] !== profile.statusAppId)) {
    throw new Error('destination has conflicting publishers for the pinned status check')
  }
  const targetRules: Rule[] = []
  const noBypassRules: Rule[] = []
  let otherUpdates = false
  for (const set of rulesets) {
    if (!ownerBypassOnly(set, ownerId)) continue
    if (exactScope(set, '~ALL', [ownRef]) && !effective.has(set.id) && simpleRule(set.rules, 'update')) otherUpdates = true
    if (!exactScope(set, ownRef, [])) continue
    const applied = effective.get(set.id) ?? []
    if (canonical(canonicalOrder(set.rules)) !== canonical(canonicalOrder(applied))) {
      throw new Error('GitHub effective branch rules disagree with the ruleset')
    }
    targetRules.push(...applied)
    if (set.bypass.length === 0) noBypassRules.push(...applied)
  }

  if (!targetRules.some((item) => item.type === 'pull_request' &&
    strings(item.parameters?.['allowed_merge_methods'], ['merge']))) {
    throw new Error('destination must require pull requests with the merge commit method')
  }
  if (!targetRules.some((item) => strictCheck(item, profile))) {
    throw new Error('destination does not enforce the pinned strict status check')
  }
  if (!simpleRule(noBypassRules, 'non_fast_forward') || !simpleRule(noBypassRules, 'deletion')) {
    throw new Error('destination history guards must prohibit force pushes and deletion without bypass')
  }
  if (!otherUpdates) throw new Error('all other branches must restrict updates')
}

export function captureMergePolicy(
  target: PrTarget, profile: MergeProfile, read: MergePolicyRead = readGitHub,
): MergePolicyEvidence {
  validateTarget(target)
  const pinned = parseMergeProfile(profile)
  // Only literal names are accepted here. Other Git ref names may have
  // meaning when GitHub interprets a rule condition as a pattern.
  if (pinned.baseRef !== target.baseRef || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(target.baseRef) ||
    pinned.statusAppId === pinned.mergeAppId) throw new Error('invalid guarded merge destination or App profile')

  const prefix = `repos/${target.repo}`
  const repo = object(read(prefix))
  const repositoryId = repo?.['id']
  const owner = object(repo?.['owner'])
  const ownerId = owner?.['id']
  if (!positiveId(repositoryId) || !sameRepo(repo?.['full_name'], target.repo) ||
    owner?.['type'] !== 'User' || !positiveId(ownerId) ||
    object(repo?.['permissions'])?.['admin'] !== true || repo?.['allow_merge_commit'] !== true) {
    throw new Error('guarded merge requires an administratively visible personal repository with merge commits enabled')
  }

  const branch = encodeURIComponent(target.baseRef)
  const listPath = `${prefix}/rulesets?includes_parents=true&per_page=100`
  const listed = readListing(listPath, target.repo, read)
  const rulesets = listed.map((item) => readRuleset(prefix, target.repo, item, read))
  if (rulesets.some((set) => set.active && set.target === 'branch' && set.bypass.some((actor) =>
    actor['actor_type'] === 'Integration' && actor['actor_id'] === pinned.mergeAppId))) {
    throw new Error('merge App must not bypass any active branch ruleset')
  }
  const effective = activeRules(read(`${prefix}/rules/branches/${branch}?per_page=100`, { paginate: true }), rulesets, target.repo)
  const protection = read(`${prefix}/branches/${branch}/protection`, { unprotected: true })
  if (protection !== null && object(protection) === undefined) throw new Error('invalid GitHub classic branch protection')
  if (canonical(canonicalOrder(listed)) !== canonical(canonicalOrder(readListing(listPath, target.repo, read)))) {
    throw new Error('GitHub repository rules changed during inspection')
  }
  assertGuards(rulesets, effective, `refs/heads/${target.baseRef}`, ownerId, pinned)

  const normalized = {
    repositoryId, ownerId, defaultBranch: repo?.['default_branch'], baseRef: target.baseRef,
    rulesets: canonicalOrder(rulesets.map(({ identity, conditions, rules, bypass }) =>
      ({ identity, conditions, rules: canonicalOrder(rules), bypass: canonicalOrder(bypass) }))),
    effective: canonicalOrder([...effective].map(([id, rules]) => ({ id, rules: canonicalOrder(rules) }))),
    protection,
  }
  return { profile: pinned, repositoryId, rulesSha256: createHash('sha256').update(canonical(normalized)).digest('hex') }
}
