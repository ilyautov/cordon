import { describe, expect, it, vi } from 'vitest'
import { captureMergePolicy } from '../../src/pr-workflow/merge-policy.js'

const profile = { baseRef: 'release/target', statusAppId: 123, statusAppSlug: 'cordon-status',
  statusContext: 'cordon/verified', mergeAppId: 456 }
const target = { repo: 'example/project', number: 12, baseRef: profile.baseRef,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }
const root = `repos/${target.repo}`
const ref = `refs/heads/${target.baseRef}`
const list = `${root}/rulesets?includes_parents=true&per_page=100`
const effective = `${root}/rules/branches/${encodeURIComponent(target.baseRef)}?per_page=100`
const classic = `${root}/branches/${encodeURIComponent(target.baseRef)}/protection`
const ownerId = 404
const repo = { id: 85, full_name: 'Example/Project', owner: { id: ownerId, type: 'User' },
  permissions: { admin: true }, default_branch: 'main', allow_merge_commit: true }
const human = { actor_type: 'User', actor_id: ownerId, bypass_mode: 'always' }
const merge = { type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }
const status = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
  do_not_enforce_on_create: false,
  required_status_checks: [{ integration_id: profile.statusAppId, context: profile.statusContext }] } }

function ruleset(id: number, rules: Array<{ type: string; parameters?: unknown }>, bypass: unknown[] = [],
  include = [ref], exclude: string[] = []) {
  return { id, name: `Rules ${id}`, source: repo.full_name, source_type: 'Repository',
    target: 'branch', enforcement: 'active', node_id: `RRS_${id}`, updated_at: '2026-11-22T10:00:00.000Z',
    conditions: { ref_name: { include, exclude } }, rules, bypass_actors: bypass }
}

function fixture() {
  const guard = ruleset(1, [merge, status, { type: 'non_fast_forward' }], [human])
  const other = ruleset(2, [{ type: 'update' }], [human], ['~ALL'], [ref])
  const history = ruleset(3, [{ type: 'non_fast_forward' }, { type: 'deletion' }])
  const inactive = { ...ruleset(4, [{ type: 'creation' }]), enforcement: 'disabled' }
  const rulesets = structuredClone([guard, other, history, inactive])
  const data = { repo: structuredClone(repo), classic: null as unknown,
    effective: undefined as unknown, rulesets }
  const read = vi.fn((endpoint: string) => {
    if (endpoint === root) return data.repo
    if (endpoint === list) return [data.rulesets.map(({ id, source, source_type, enforcement, updated_at }) =>
      ({ id, source, source_type, enforcement, updated_at }))]
    if (endpoint === effective) return data.effective ?? [data.rulesets
      .filter(({ enforcement, conditions }) => enforcement === 'active' &&
        conditions.ref_name.include.includes(ref) && !conditions.ref_name.exclude.includes(ref))
      .flatMap(({ id, rules, source, source_type }) => rules.map((rule) => ({ ...rule, ruleset_id: id,
        ruleset_source: source, ruleset_source_type: source_type })))]
    if (endpoint === classic) return data.classic
    const selected = data.rulesets.find(({ id }) => endpoint === `${root}/rulesets/${id}`)
    if (selected) return selected
    throw new Error('unexpected GitHub policy read')
  })
  const capture = () => captureMergePolicy(target, profile, read)
  return { data, read, capture }
}

describe('GitHub guarded merge policy', () => {
  it('captures the exact destination, matching status App, and both branch guards', () => {
    const { capture, read } = fixture()
    expect(capture()).toEqual({ profile, repositoryId: repo.id, rulesSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(read.mock.calls.flat().filter((entry) => typeof entry === 'string')).toEqual(expect.arrayContaining([
      root, list, effective, classic, `${root}/rulesets/1`, `${root}/rulesets/2`, `${root}/rulesets/3`, `${root}/rulesets/4`,
    ]))
  })

  it('rejects the wrong approved destination before reading from GitHub', () => {
    const { read } = fixture()
    expect(() => captureMergePolicy({ ...target, baseRef: 'other' }, profile, read)).toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('accepts separate exact destination rulesets for each required safeguard', () => {
    const { data, capture } = fixture()
    data.rulesets[0]!.rules = [merge]
    data.rulesets[2]!.rules = [{ type: 'non_fast_forward' }]
    data.rulesets.push(ruleset(5, [status], [human]), ruleset(6, [{ type: 'deletion' }]))
    expect(capture().repositoryId).toBe(repo.id)
  })

  it.each([ref, 'refs/heads/release/other'])('refuses a merge App bypass on a supplemental rule for %s', (scope) => {
    const { data, capture } = fixture()
    const supplemental = ruleset(5, [{ type: 'required_signatures' }], [], [scope])
    data.rulesets.push(supplemental)
    expect(capture().repositoryId).toBe(repo.id)

    supplemental.bypass_actors.push({ actor_id: profile.mergeAppId, actor_type: 'Integration', bypass_mode: 'pull_request' })
    expect(capture).toThrow(/merge App.*bypass/)

    supplemental.enforcement = 'disabled'
    expect(capture().repositoryId).toBe(repo.id)
  })

  it.each([
    ['admin permissions', (data: ReturnType<typeof fixture>['data']) => { data.repo.permissions.admin = false }],
    ['personal ownership', (data: ReturnType<typeof fixture>['data']) => { data.repo.owner.type = 'Organization' }],
    ['bypass visibility', (data: ReturnType<typeof fixture>['data']) => {
      Object.assign(data.rulesets[0]!, { bypass_actors: undefined })
    }],
    ['merge App bypass', (data: ReturnType<typeof fixture>['data']) => {
      data.rulesets[0]!.bypass_actors.push({ ...human, actor_type: 'Integration', actor_id: profile.mergeAppId })
    }],
    ['history bypass', (data: ReturnType<typeof fixture>['data']) => { data.rulesets[2]!.bypass_actors.push(human) }],
    ['strict status checking', (data: ReturnType<typeof fixture>['data']) => {
      data.rulesets[0]!.rules[1] = { ...status, parameters: { ...status.parameters, strict_required_status_checks_policy: false } }
    }],
    ['expected status author', (data: ReturnType<typeof fixture>['data']) => {
      data.rulesets[0]!.rules[1] = { ...status, parameters: { ...status.parameters,
        required_status_checks: [{ ...status.parameters.required_status_checks[0], integration_id: 999 }] } }
    }],
    ['conflicting publisher for the same effective status context', (data: ReturnType<typeof fixture>['data']) => {
      data.rulesets.push(ruleset(5, [{ ...status, parameters: { ...status.parameters,
        required_status_checks: [{ integration_id: 999, context: profile.statusContext.toUpperCase() }] } }]))
    }],
    ['guard for all other branches', (data: ReturnType<typeof fixture>['data']) => {
      data.rulesets[1]!.conditions.ref_name.exclude.push('refs/heads/another')
    }],
    ['recognized history guard semantics', (data: ReturnType<typeof fixture>['data']) => {
      data.rulesets[2]!.rules[0] = { type: 'non_fast_forward', parameters: { mode: 'unrecognized' } }
    }],
    ['active ruleset', (data: ReturnType<typeof fixture>['data']) => { data.rulesets[2]!.enforcement = 'evaluate' }],
    ['effective branch rules', (data: ReturnType<typeof fixture>['data']) => { data.effective = [[]] }],
  ])('refuses missing proof of %s', (_name, configure) => {
    const { data, capture } = fixture()
    configure(data)
    expect(capture).toThrow()
  })

  it('rejects a malformed or incomplete ruleset listing', () => {
    const { read, capture } = fixture()
    read.mockImplementationOnce(() => repo).mockImplementationOnce(() => [{ id: 1 }])
    expect(capture).toThrow()
  })

  it('does not pin a mixed snapshot when the rules change during inspection', () => {
    const { data, read } = fixture()
    let listings = 0
    expect(() => captureMergePolicy(target, profile, (endpoint) => {
      if (endpoint === list && ++listings === 2) {
        data.rulesets[0]!.updated_at = '2026-11-22T10:10:00.000Z'
      }
      return read(endpoint)
    })).toThrow(/rules changed during inspection/)
  })

  it('fingerprints inactive rules and classic protection while normalizing ruleset and rule order', () => {
    const { data, capture } = fixture()
    const original = capture().rulesSha256
    data.rulesets.reverse()
    data.rulesets.forEach(({ rules }) => rules.reverse())
    expect(capture().rulesSha256).toBe(original)
    data.rulesets.find(({ id }) => id === 4)!.updated_at = '2026-11-22T10:10:00.000Z'
    const newer = capture().rulesSha256
    expect(newer).not.toBe(original)
    data.classic = { required_linear_history: { enabled: true } }
    expect(capture().rulesSha256).not.toBe(newer)
  })
})
