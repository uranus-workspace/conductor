// Phase 3: Jev client, decision model, shadow/enforce router, labels, report.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { DecisionRecord, LabelRecord } from '../../src/adapters/decision/decision.types.ts'
import { JevClient, JevDecisionModel, shuffle } from '../../src/adapters/decision/jev.ts'
import { buildReport, reportText } from '../../src/adapters/decision/report.ts'
import { DecisionLog, DecisionRouter } from '../../src/adapters/decision/router.ts'
import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { Host } from '../../src/core/host.types.ts'
import type { Classification, Task } from '../../src/core/domain.types.ts'
import { nodeHost } from '../support/node-host.ts'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', runId: 'r', title: 'Add login rate limit', description: 'Limit login attempts. Token sk-ant-api03-zzzzzzzzzzzzzzzzzzzz',
  acceptance: ['5 attempts per minute'], files: ['src/auth/login.ts'], dependsOn: [], status: 'planned', attempts: [], ...over,
})

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function jevHost(dir: string, reply: (body: Record<string, unknown>) => unknown, opts: { delayMs?: number } = {}) {
  const sent: Sent[] = []
  const host = nodeHost(dir, dir, {
    openrouterKey: 'or-key',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      sent.push({ url, headers: init.headers ?? {}, body })
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      return { status: 200, ok: true, text: JSON.stringify(reply(body)) }
    },
  })
  return { host, sent }
}

const CLASSIFY_REPLY = {
  model: 'jev-1.13.0',
  answers: {
    executor: { type: 'choice', choice: 'codex', confidence: 0.9, probabilities: { codex: 0.9 } },
    complexity: { type: 'score', score: 1.2, confidence: 0.8 },
    risk: { type: 'score', score: 0.4, confidence: 0.9 },
    parallelizable: { type: 'noul', noul: 0.9 },
    needsHuman: { type: 'noul', noul: 0.1 },
  },
  usage: { input_tokens: 300, output_tokens: 10 },
}

const cfg = { baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.14', timeoutMs: 500 }

describe('Jev client and model', () => {
  it('sends one batched, redacted, shuffled request in the documented shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-'))
    const { host, sent } = jevHost(dir, () => CLASSIFY_REPLY)
    const model = new JevDecisionModel(new JevClient(host, cfg), DEFAULT_CONFIG.riskPaths, () => 0)
    const c = await model.classify(task(), { openTaskFiles: [], available: ['claude', 'codex', 'opencode'] })

    assert.equal(sent.length, 1, 'every question about one state in one call')
    assert.equal(sent[0]?.url, 'https://openrouter.ai/api/v1/systemone')
    assert.equal(sent[0]?.headers.authorization, 'Bearer or-key')
    const body = sent[0]!.body as { model: string; state: unknown; questions: Record<string, { type: string; criteria?: unknown }> }
    assert.equal(body.model, 'typesafe/jev-1.14')
    assert.deepEqual(Object.keys(body.questions).sort(), ['complexity', 'executor', 'needsHuman', 'parallelizable', 'risk', 'template'])
    assert.equal(body.questions.executor?.type, 'choice')
    const options = Object.keys(body.questions.executor?.criteria as object)
    assert.equal(options.at(-1), 'other')
    assert.notDeepEqual(options.slice(0, 3), ['claude', 'codex', 'opencode'], 'options reordered')
    assert.ok(!JSON.stringify(body.state).includes('zzzzzzzzzzzz'), 'secret redacted')

    assert.equal(c.executor, 'codex')
    assert.equal(c.complexity, 2)
    assert.equal(c.risk, 4, 'Jev said risk 1, the auth/ floor wins')
    assert.equal(c.tier, 'strong')
    assert.equal(c.source, 'jev')
    assert.equal(c.model, 'jev-1.13.0')
  })

  it('falls back when Jev picks other or an unavailable worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-'))
    const reply = { ...CLASSIFY_REPLY, answers: { ...CLASSIFY_REPLY.answers, executor: { type: 'choice', choice: 'other', confidence: 0.9 } } }
    const { host } = jevHost(dir, () => reply)
    const c = await new JevDecisionModel(new JevClient(host, cfg), [], () => 0.5).classify(task({ files: [] }), { openTaskFiles: [], available: ['codex'] })
    assert.equal(c.executor, 'codex')
  })

  it('asks verified and scopeCreep together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-'))
    const { host, sent } = jevHost(dir, () => ({ model: 'jev-1.13.0', answers: { verified: { type: 'noul', noul: 0.93 }, scopeCreep: { type: 'noul', noul: 0.4 } } }))
    const v = await new JevDecisionModel(new JevClient(host, cfg), []).isVerified(task(), { checksPassed: true, changedFiles: ['src/auth/login.ts'], diffStat: '1 file changed' })
    assert.deepEqual(v, { verified: 0.93, scopeCreep: 0.4, source: 'jev', model: 'jev-1.13.0' })
    assert.deepEqual(Object.keys((sent[0]!.body as { questions: object }).questions).sort(), ['scopeCreep', 'verified'])
  })

  it('times out (fail open is the router\'s job)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-'))
    const { host } = jevHost(dir, () => CLASSIFY_REPLY, { delayMs: 300 })
    const client = new JevClient(host, { ...cfg, timeoutMs: 50 })
    await assert.rejects(client.ask('s', { q: { type: 'noul', instructions: 'x?' } }), /timeout/)
  })

  it('shuffle keeps every item', () => {
    const items = ['a', 'b', 'c', 'd']
    assert.deepEqual(shuffle(items).sort(), items)
  })
})

function router(host: Host, mode: 'shadow' | 'enforce', jev: Partial<JevDecisionModel>, random = () => 0.99) {
  const log = new DecisionLog(host, `${host.cwd}/.conductor/jev`)
  return {
    log,
    r: new DecisionRouter({
      host, rules: new RuleDecisionModel(DEFAULT_CONFIG.riskPaths), jev: jev as JevDecisionModel, mode,
      log, riskPaths: DEFAULT_CONFIG.riskPaths, random,
    }),
  }
}

const jevSays = (over: Partial<Classification>): Classification => ({
  executor: 'cursor', tier: 'cheap', complexity: 1, risk: 1, parallelizable: 1, needsHuman: 0, source: 'jev', model: 'jev-1.13.0',
  confidence: { executor: 0.9, complexity: 0.9, risk: 0.9 }, ...over,
})

describe('DecisionRouter', () => {
  const ctx = { openTaskFiles: [], available: ['claude', 'codex', 'cursor'] as Classification['executor'][] }

  it('shadow: the rules decide, Jev is only logged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rt-'))
    const { r, log } = router(nodeHost(dir, dir), 'shadow', { classify: async () => jevSays({}) })
    const c = await r.classify(task({ files: ['src/ui/a.tsx'], title: 'Fix typo', description: 'typo' }), ctx)
    assert.equal(c.source, 'rules')
    const [rec] = (await log.readAll()) as DecisionRecord[]
    assert.equal(rec?.kind, 'classify')
    assert.equal((rec as { jev?: Classification }).jev?.executor, 'cursor')
  })

  it('enforce: Jev where confident, rules elsewhere, risk floored, tier recomputed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rt-'))
    const { r } = router(nodeHost(dir, dir), 'enforce', {
      classify: async () => jevSays({ confidence: { executor: 0.9, complexity: 0.2, risk: 0.9 } }),
    })
    const c = await r.classify(task(), ctx)
    assert.equal(c.executor, 'cursor', 'confident executor taken')
    assert.notEqual(c.complexity, 1, 'unconfident complexity left to the rules')
    assert.equal(c.risk, 4, 'auth/ floor beats Jev\'s risk 1')
    assert.equal(c.tier, 'strong')
  })

  it('enforce fails open: a Jev error falls back to the rules and is logged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rt-'))
    const { r, log } = router(nodeHost(dir, dir), 'enforce', { classify: async () => { throw new Error('HTTP 503') } })
    const c = await r.classify(task(), ctx)
    assert.equal(c.source, 'rules')
    assert.match(String(((await log.readAll())[0] as { error?: string }).error), /503/)
  })

  it('hard failures stay closed: Jev is not asked to overrule failed checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rt-'))
    let asked = 0
    const { r } = router(nodeHost(dir, dir), 'enforce', {
      isVerified: async () => {
        asked++
        return { verified: 0.99, source: 'jev' as const }
      },
    })
    const v = await r.isVerified(task(), { checksPassed: false, changedFiles: ['a'] })
    assert.equal(v.verified, 0)
    assert.equal(asked, 0)
  })

  it('monitors consistency by asking twice at the sample rate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rt-'))
    let n = 0
    const { r, log } = router(nodeHost(dir, dir), 'shadow', { classify: async () => jevSays({ executor: n++ % 2 ? 'codex' : 'cursor' }) }, () => 0)
    await r.classify(task(), ctx)
    const monitor = (await log.readAll()).find(x => x.kind === 'monitor') as Extract<DecisionRecord, { kind: 'monitor' }>
    assert.equal(monitor.first.executor, 'cursor')
    assert.equal(monitor.second.executor, 'codex')
  })
})

describe('report', () => {
  it('measures agreement, consistency and suggests a verified threshold from labels', () => {
    const records: Array<DecisionRecord | LabelRecord> = []
    const rules = jevSays({ executor: 'claude', tier: 'standard', source: 'rules' })
    for (let i = 0; i < 12; i++) {
      const id = `t${i}`
      const good = i % 3 !== 0
      records.push({ kind: 'classify', at: '2026-11-03', taskId: id, mode: 'shadow', rules, jev: jevSays({ executor: i % 2 ? 'claude' : 'codex' }), used: rules })
      records.push({ kind: 'verify', at: '2026-11-03', taskId: id, attempt: 1, mode: 'shadow', rules: { verified: 0.8, source: 'rules' }, jev: { verified: good ? 0.9 : 0.6, source: 'jev', model: 'jev-1.13.0' }, used: { verified: 0.8, source: 'rules' } })
      records.push({ kind: 'label', at: '2026-11-03', taskId: id, finalStatus: good ? 'merged' : 'failed', attempts: good ? 1 : 3, cleanFirstTry: good, reviewedByMaestro: false, tiers: good ? ['standard'] : ['standard', 'strong', 'strong'], executors: ['claude'] })
    }
    records.push({ kind: 'monitor', at: '2026-11-03', taskId: 't0', first: jevSays({}), second: jevSays({ complexity: 2 }) })
    const report = buildReport(records)
    assert.equal(report.agreement?.executor, 0.5)
    assert.equal(report.consistency?.executor, 1)
    assert.equal(report.consistency?.complexityWithin1, 1)
    assert.ok(report.suggestion.verified)
    assert.equal(report.suggestion.verified?.accuracy, 1)
    assert.ok((report.suggestion.verified?.threshold ?? 0) > 0.6 && (report.suggestion.verified?.threshold ?? 1) <= 0.9)
    assert.ok((report.suggestion.verified?.rulesAccuracy ?? 1) < 1)
    assert.deepEqual(report.models, ['jev-1.13.0'])
    assert.match(reportText(report, 'shadow'), /suggested verified threshold/)
  })
})
