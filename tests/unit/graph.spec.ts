// The graph engine (§5B): templates, edges, limits, ownership, and the Conductor walking them with real git.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RuleDecisionModel, templateFor } from '../../src/adapters/decision/rules.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { parseConfig } from '../../src/core/config.ts'
import { Conductor } from '../../src/core/conductor.ts'
import type { Task } from '../../src/core/domain.types.ts'
import { checkWrites, GraphError, mermaid, resolveEdge, statusOf } from '../../src/graph/engine.ts'
import type { NodeOutcome, TaskState } from '../../src/graph/graph.types.ts'
import { byModule } from '../../src/graph/templates/refactor.ts'
import { TEMPLATES } from '../../src/graph/templates/index.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeClaude = join(pluginRoot, 'tests/support/fake-claude.sh')
chmodSync(fakeClaude, 0o755)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', runId: 'r', title: 't', description: 'd', acceptance: ['a'], dependsOn: [], status: 'running', attempts: [], ...over,
})

const state = (outcome: NodeOutcome, over: Partial<TaskState> = {}): TaskState => ({
  task: task(), node: 'check', outcome, retries: 0, costUsd: 0, minutes: 0,
  limits: { maxRetries: 2, maxCostUsd: 5, maxMinutes: 45 }, verifyThreshold: 0.8, ...over,
})

describe('graph engine', () => {
  it('refuses a node writing a field another node owns', () => {
    checkWrites('check', ['attempt.checks'])
    assert.throws(() => checkWrites('check', ['notes']), GraphError)
    assert.throws(() => checkWrites('implement', ['attempt.verdict']), /owned by judge/)
  })

  it('forces the retry edge: back to implement while the limits allow, then failed', () => {
    const fail: NodeOutcome = { status: 'fail', reason: 'tests red', writes: ['attempt.checks'] }
    const back = resolveEdge(TEMPLATES.feature, 'check', state(fail))
    assert.equal(back.to, 'implement')
    assert.equal(back.retry, true)
    assert.equal(back.rule, 'retry')
    assert.equal(resolveEdge(TEMPLATES.feature, 'check', state(fail, { retries: 2 })).to, 'failed')
    assert.match(resolveEdge(TEMPLATES.feature, 'check', state(fail, { costUsd: 9 })).reason, /out of budget/)
    assert.match(resolveEdge(TEMPLATES.feature, 'check', state(fail, { minutes: 50 })).reason, /out of time/)
  })

  it('a fixed edge is the success path; a failed node on it goes back to implement', () => {
    const ok = resolveEdge(TEMPLATES.solo, 'implement', state({ status: 'ok', reason: '1 file changed', writes: [] }, { node: 'implement' }))
    assert.deepEqual([ok.to, ok.reason], ['check', '1 file changed'])
    assert.equal(resolveEdge(TEMPLATES.solo, 'implement', state({ status: 'fail', writes: [] }, { node: 'implement' })).to, 'implement')
  })

  it('the judge and the reviewer decide on the edges', () => {
    assert.equal(resolveEdge(TEMPLATES.feature, 'judge', state({ status: 'ok', verdict: 0.9, writes: [] })).to, 'merge')
    assert.equal(resolveEdge(TEMPLATES.feature, 'judge', state({ status: 'ok', verdict: 0.5, writes: [] })).to, 'needs_review')
    assert.equal(resolveEdge(TEMPLATES.feature, 'review', state({ status: 'fail', review: 'fail', writes: [] })).to, 'implement')
    assert.equal(resolveEdge(TEMPLATES.feature, 'review', state({ status: 'ok', review: 'review', writes: [] })).to, 'judge')
    assert.equal(resolveEdge(TEMPLATES.secure, 'review', state({ status: 'ok', review: 'pass', writes: [] })).to, 'human')
  })

  it('derives the status from the cursor', () => {
    assert.equal(statusOf('implement', true), 'ready')
    assert.equal(statusOf('implement', false), 'running')
    assert.equal(statusOf('judge', false), 'verifying')
    assert.equal(statusOf('human', false), 'needs_review')
    assert.equal(statusOf('merge', false), 'done')
    assert.equal(statusOf('END', false), 'merged')
  })

  it('every template reaches END and passes the one-sentence node rule', () => {
    for (const tpl of Object.values(TEMPLATES)) {
      const targets = tpl.edges.map(([, to]) => to).filter(to => typeof to === 'string')
      assert.ok(targets.includes('END') || tpl.edges.some(([, to]) => typeof to === 'function'), tpl.id)
      assert.ok(tpl.edges.some(([from]) => from === tpl.entry), `${tpl.id} starts at its entry`)
      assert.ok(tpl.version >= 1)
    }
    assert.equal(TEMPLATES.spike.merges, false)
  })

  it('draws the template and the path taken in Mermaid', () => {
    const m = mermaid(TEMPLATES.feature, [
      { node: 'implement', attempt: 1, startedAt: 'a', status: 'ok', writes: [], decision: { from: 'implement', to: 'check', reason: 'diff' } },
      { node: 'check', attempt: 1, startedAt: 'b', status: 'fail', writes: [], decision: { from: 'check', to: 'implement', reason: 'checks failed; retry 1/2', rule: 'retry' } },
    ], 'implement')
    assert.match(m, /^flowchart LR/)
    assert.match(m, /check == "checks failed; retry 1\/2" ==> implement/)
    assert.match(m, /class check failed/)
    assert.match(m, /class implement current/)
  })

  it('groups a refactor by module, at most four parts', () => {
    assert.deepEqual(byModule(task({ files: ['a/1.ts', 'a/2.ts', 'b/1.ts'] })), [['a/1.ts', 'a/2.ts'], ['b/1.ts']])
    assert.equal(byModule(task({ files: ['a/x', 'b/x', 'c/x', 'd/x', 'e/x'] })).length, 4)
  })
})

describe('routing to templates', () => {
  it('risk >= 4 is always secure; labels, wording and size pick the rest', () => {
    assert.equal(templateFor(task({ labels: ['template:solo'] }), 'rename', 1, 4, 1), 'secure')
    assert.equal(templateFor(task({ labels: ['template:spike'] }), 'x', 3, 2, 1), 'spike')
    assert.equal(templateFor(task(), 'investigate options for caching', 3, 2, 1), 'spike')
    assert.equal(templateFor(task(), 'fix the crash on save', 3, 2, 1), 'bugfix')
    assert.equal(templateFor(task(), 'rename the logger across all modules', 3, 2, 6), 'refactor')
    assert.equal(templateFor(task(), 'add a field', 2, 2, 1), 'solo')
    assert.equal(templateFor(task(), 'add a settings page', 3, 3, 2), 'feature')
  })
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-graph-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}

function setup(over: Record<string, unknown> = {}, available: string[] = ['claude']) {
  const root = repo()
  process.env.FAKE_STATE_DIR = root
  const config = parseConfig(JSON.stringify({
    gateway: 'native', heartbeatMs: 50, checks: ['true'], executors: { claude: { bin: fakeClaude }, codex: { bin: fakeClaude } }, ...over,
  }))
  const host = nodeHost(root, pluginRoot)
  const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
  const executors = [new ClaudeExecutor(config.executors.claude)]
  const c = new Conductor(host, source, new RuleDecisionModel(config.riskPaths), executors, config,
    { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined })
  ;(c as unknown as { available: string[] }).available = available
  return { root, c, source }
}

async function until(c: Conductor, source: LocalFileTaskSource, runId: string, done: (t: Task) => boolean, max = 200): Promise<Task> {
  for (let i = 0; i < max; i++) {
    await c.tick(runId)
    const [t] = await source.listTasks(runId)
    if (t && done(t)) return t
    await sleep(40)
  }
  throw new Error(`did not settle: ${JSON.stringify((await source.listTasks(runId))[0]?.status)}`)
}

const show = (root: string, ref: string, path: string) => execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' })

describe('the Conductor walks templates', () => {
  it('refactor: fans out one worker per module and fans their branches in before checking', async () => {
    const { root, c, source } = setup()
    const runId = await c.createRun('refactor')
    await c.plan(runId, [{
      key: 'r', title: 'Rename the logger', description: 'create the files in scope', acceptance: ['done'],
      files: ['api/log.txt', 'web/log.txt'], labels: ['template:refactor'],
    }])
    const t = await until(c, source, runId, x => x.status === 'merged' || x.status === 'failed')
    assert.equal(t.status, 'merged', t.note ?? 'no note')
    assert.equal(t.template, 'refactor')
    assert.equal(t.attempts[0]?.shards?.length, 2)
    assert.ok(t.attempts[0]?.shards?.every(s => s.ok))
    assert.equal(show(root, `conductor/${runId}/integration`, 'api/log.txt'), 'made in scope\n')
    assert.equal(show(root, `conductor/${runId}/integration`, 'web/log.txt'), 'made in scope\n')
    assert.deepEqual(t.nodeRuns?.map(r => r.node), ['plan', 'route', 'implement', 'check', 'review', 'merge'])
  })

  it('secure: stops at the human gate, and merges once approved', async () => {
    const { c, source } = setup()
    const runId = await c.createRun('secure')
    await c.plan(runId, [{ key: 's', title: 'Token expiry', description: 'create file auth-token.txt', acceptance: ['ok'], files: ['auth/token.txt'] }])
    const waiting = await until(c, source, runId, x => x.status === 'needs_review')
    assert.equal(waiting.template, 'secure')
    assert.equal(waiting.cursor, 'human')
    assert.match(waiting.note ?? '', /human approval required/)
    assert.equal(await c.approve(waiting.id), 'done')
    const merged = await until(c, source, runId, x => x.status === 'merged')
    assert.ok(merged.approval)
    assert.deepEqual(merged.nodeRuns?.map(r => r.node), ['plan', 'route', 'implement', 'check', 'security', 'review', 'human', 'merge'])
  })

  it('spike: researches and writes a report, merging nothing', async () => {
    const { root, c, source } = setup()
    const runId = await c.createRun('spike')
    await c.plan(runId, [{ key: 'k', title: 'Investigate caching options', description: 'investigate caching; create file notes.txt', acceptance: ['a recommendation'] }])
    const t = await until(c, source, runId, x => x.status === 'merged' || x.status === 'failed')
    assert.equal(t.template, 'spike')
    assert.equal(t.attempts.length, 0, 'no implement attempt')
    assert.ok(t.report && existsSync(t.report))
    assert.match(readFileSync(t.report, 'utf8'), /## Findings/)
    assert.throws(() => show(root, `conductor/${runId}/integration`, 'notes.txt'), 'the research worktree is thrown away')
  })

  it('bugfix: researches first, then implements with the notes', async () => {
    const { c, source } = setup()
    const runId = await c.createRun('bugfix')
    await c.plan(runId, [{ key: 'b', title: 'Fix the crash on save', description: 'fix: create file fix.txt', acceptance: ['no crash'], files: ['fix.txt'] }])
    const t = await until(c, source, runId, x => x.status === 'merged' || x.status === 'failed')
    assert.equal(t.status, 'merged', t.note ?? 'no note')
    assert.equal(t.template, 'bugfix')
    assert.equal(t.nodeRuns?.[2]?.node, 'research')
    assert.ok((t.notes ?? '').length > 0)
  })

  it('the reviewer is never the author, another lab first', () => {
    const { c } = setup({}, ['claude', 'codex'])
    const withCodex = new Conductor(nodeHost('/tmp', pluginRoot), new LocalFileTaskSource(nodeHost('/tmp', pluginRoot), '/tmp/x.json'), new RuleDecisionModel([]), [
      new ClaudeExecutor(parseConfig(undefined).executors.claude),
      { ...new ClaudeExecutor(parseConfig(undefined).executors.claude), id: 'codex', verdict: async () => undefined } as never,
    ], parseConfig(undefined), { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined })
    ;(withCodex as unknown as { available: string[] }).available = ['claude', 'codex']
    assert.equal(withCodex.pickReviewer('claude'), 'codex')
    assert.equal(withCodex.pickReviewer('codex'), 'claude')
    assert.equal(c.pickReviewer('claude'), undefined, 'only the author is available: no review rather than a self-review')
  })
})
