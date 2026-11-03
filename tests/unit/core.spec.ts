import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RuleDecisionModel, scopeCreep } from '../../src/adapters/decision/rules.ts'
import { DEFAULT_CONFIG, parseConfig } from '../../src/core/config.ts'
import { escalate, pickAvailable, riskFloor, tierFor } from '../../src/core/routing.ts'
import { canTransition, findCycle, isBlocked, isReady } from '../../src/core/state-machine.ts'
import type { Task } from '../../src/core/domain.types.ts'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', runId: 'r', title: 'Add a field', description: 'Add a field to the form', acceptance: ['field shows'],
  dependsOn: [], status: 'planned', attempts: [], ...over,
})

describe('state machine', () => {
  it('allows the documented edges and refuses the rest', () => {
    assert.ok(canTransition('planned', 'classified'))
    assert.ok(canTransition('verifying', 'needs_review'))
    assert.ok(canTransition('failed', 'ready'))
    assert.ok(canTransition('running', 'cancelled'))
    assert.ok(!canTransition('planned', 'running'))
    assert.ok(!canTransition('merged', 'cancelled'))
    assert.ok(!canTransition('done', 'running'))
  })

  it('is ready only when every dependency is merged', () => {
    const a = task({ id: 'a', status: 'done' })
    const b = task({ id: 'b', dependsOn: ['a'] })
    assert.equal(isReady(b, [a, b]), false)
    assert.equal(isReady(b, [{ ...a, status: 'merged' }, b]), true)
  })

  it('blocks dependents of a final failure', () => {
    const a = task({ id: 'a', status: 'failed' })
    const b = task({ id: 'b', dependsOn: ['a'] })
    assert.equal(isBlocked(b, [a, b], () => true), true)
    assert.equal(isBlocked(b, [a, b], () => false), false)
  })

  it('finds dependency cycles', () => {
    assert.equal(findCycle([task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b', dependsOn: ['a'] })]) !== undefined, true)
    assert.equal(findCycle([task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'] })]), undefined)
  })
})

describe('routing', () => {
  it('maps scores to tiers in code (doc §7.1)', () => {
    assert.equal(tierFor(4, 1), 'strong')
    assert.equal(tierFor(1, 4), 'strong')
    assert.equal(tierFor(2, 2), 'cheap')
    assert.equal(tierFor(3, 2), 'standard')
  })

  it('escalates one tier per retry, capped', () => {
    assert.equal(escalate('cheap', 1), 'standard')
    assert.equal(escalate('cheap', 5), 'strong')
  })

  it('floors risk on sensitive paths', () => {
    assert.equal(riskFloor(['src/auth/login.ts'], DEFAULT_CONFIG.riskPaths), 4)
    assert.equal(riskFloor(['src/fiscal/taxRules.ts'], DEFAULT_CONFIG.riskPaths), 4)
    assert.equal(riskFloor(['.env.local'], DEFAULT_CONFIG.riskPaths), 4)
    assert.equal(riskFloor(['src/ui/button.tsx'], DEFAULT_CONFIG.riskPaths), 1)
  })

  it('falls back to an available executor', () => {
    assert.equal(pickAvailable('cursor', ['codex', 'claude']), 'claude')
    assert.equal(pickAvailable('codex', ['codex']), 'codex')
    assert.equal(pickAvailable('codex', []), undefined)
  })
})

describe('RuleDecisionModel', () => {
  const rules = new RuleDecisionModel(DEFAULT_CONFIG.riskPaths)
  const ctx = { openTaskFiles: [], available: ['claude', 'codex', 'opencode'] as const }

  it('sends risky work to claude on the strong tier, whatever the wording', async () => {
    const c = await rules.classify(task({ title: 'Fix typo', files: ['src/billing/invoice.ts'] }), { ...ctx, available: [...ctx.available] })
    assert.equal(c.risk >= 4, true)
    assert.equal(c.tier, 'strong')
    assert.equal(c.executor, 'claude')
    assert.equal(c.source, 'rules')
  })

  it('sends trivial work to the cheap worker', async () => {
    const c = await rules.classify(task({ title: 'Fix typo in README', files: ['README.md'] }), { ...ctx, available: [...ctx.available] })
    assert.equal(c.tier, 'cheap')
    assert.equal(c.executor, 'opencode')
  })

  it('honours an executor label', async () => {
    const c = await rules.classify(task({ labels: ['executor:codex'] }), { ...ctx, available: [...ctx.available] })
    assert.equal(c.executor, 'codex')
  })

  it('computes parallelizable from declared files, not from a model', async () => {
    const c = await rules.classify(task({ files: ['a.ts'] }), { openTaskFiles: ['a.ts'], available: ['claude'] })
    assert.equal(c.parallelizable, 0)
  })

  it('never verifies failed checks or an empty change', async () => {
    assert.equal((await rules.isVerified(task(), { checksPassed: false, changedFiles: ['a'] })).verified, 0)
    assert.equal((await rules.isVerified(task(), { checksPassed: true, changedFiles: [] })).verified, 0)
    assert.ok((await rules.isVerified(task(), { checksPassed: true, reviewVerdict: 'pass', changedFiles: ['a'] })).verified >= 0.8)
    assert.ok((await rules.isVerified(task(), { checksPassed: null, changedFiles: ['a'] })).verified < 0.8)
  })

  it('measures scope creep against declared files and folders', () => {
    const t = task({ files: ['src/a.ts', 'lib/'] })
    assert.equal(scopeCreep(t, ['src/a.ts', 'lib/x/y.ts']), 0)
    assert.equal(scopeCreep(t, ['src/a.ts', 'other.ts']), 0.5)
    assert.equal(scopeCreep(task(), ['anything']), 0)
  })
})

describe('config', () => {
  it('deep-merges over the defaults, arrays replaced', () => {
    const c = parseConfig(JSON.stringify({ checks: ['npm test'], executors: { codex: { provider: 'openrouter' } }, concurrency: { total: 1 } }))
    assert.deepEqual(c.checks, ['npm test'])
    assert.equal(c.executors.codex.provider, 'openrouter')
    assert.equal(c.executors.codex.bin, 'codex')
    assert.equal(c.concurrency.total, 1)
    assert.equal(c.concurrency.claude, 2)
    assert.equal(parseConfig(undefined), DEFAULT_CONFIG)
  })
})
