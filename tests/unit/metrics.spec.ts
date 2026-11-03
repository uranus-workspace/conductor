// The metrics ledger and the project log: where they write, what they keep out, what /conduct stats
// makes of them, and what a real run records.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { parseConfig } from '../../src/core/config.ts'
import { Conductor } from '../../src/core/conductor.ts'
import { AppendBuffer, LineLog, MetricsLog, metricsDirOf, readMetrics } from '../../src/core/metrics.ts'
import type { MetricRecord } from '../../src/core/metrics.types.ts'
import { buildStats, errorShape, statsText } from '../../src/core/stats.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeClaude = join(pluginRoot, 'tests/support/fake-claude.sh')
chmodSync(fakeClaude, 0o755)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const DAY = Date.parse('2026-11-03T12:00:00.000Z')

describe('metrics ledger', () => {
  it('writes one file per session and day, redacted, and reads back what is in the period', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-metrics-'))
    const host = nodeHost(dir, pluginRoot)
    const buffer = new AppendBuffer(host)
    let now = DAY
    const log = new MetricsLog(buffer, { dir: `${dir}/metrics`, session: '7f3a9c2e-1111-2222', project: '/p/app' }, () => now)
    log.record({ kind: 'run.created', runId: 'r1', goal: 'ship it with key sk-or-v1-abcdef0123456789abcdef0123' })
    log.record({ kind: 'error', where: 'advance', message: 'boom for CPF 529.982.247-25' })
    now = DAY + 86_400_000
    log.record({ kind: 'session.end', reason: 'other' })
    await buffer.flush()

    assert.deepEqual(readdirSync(`${dir}/metrics/2026-11`).sort(), ['2026-11-03-7f3a9c2e.jsonl', '2026-11-04-7f3a9c2e.jsonl'])
    const raw = readFileSync(`${dir}/metrics/2026-11/2026-11-03-7f3a9c2e.jsonl`, 'utf8')
    assert.ok(!raw.includes('sk-or-v1-abcdef'), 'the key reached the ledger')
    assert.ok(!raw.includes('529.982.247-25'), 'the CPF reached the ledger')
    // A torn line (a crash mid-write) is skipped.
    writeFileSync(`${dir}/metrics/2026-11/2026-11-03-7f3a9c2e.jsonl`, `${raw}{"v":1,"kind":"run.cre`)

    const all = await readMetrics(host, `${dir}/metrics`, DAY - 3_600_000)
    assert.deepEqual(all.map(r => r.kind), ['run.created', 'error', 'session.end'])
    assert.equal(all[0]?.session, '7f3a9c2e-1111-2222')
    assert.equal(all[0]?.project, '/p/app')
    const later = await readMetrics(host, `${dir}/metrics`, DAY + 3_600_000)
    assert.deepEqual(later.map(r => r.kind), ['session.end'])
    assert.equal(metricsDirOf('', '/home/deploy'), '/home/deploy/.conductor/metrics')
    assert.equal(metricsDirOf('/data/m', '/home/deploy'), '/data/m')
  })

  it('the project log is one file per day, one line per message, redacted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-log-'))
    const buffer = new AppendBuffer(nodeHost(dir, pluginRoot))
    const log = new LineLog(buffer, `${dir}/.conductor/logs`, () => DAY)
    log.write('info', 'jira: CP-1 has no transition to "Done"')
    log.write('error', 'heartbeat: failed\nwith sk-or-v1-abcdef0123456789abcdef0123')
    await buffer.flush()
    log.write('info', 'second flush appends')
    await buffer.flush()
    const lines = readFileSync(`${dir}/.conductor/logs/conductor-2026-11-03.log`, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0] ?? '', /^2026-11-03T12:00:00.000Z info  jira: CP-1/)
    assert.match(lines[1] ?? '', /error heartbeat: failed ⏎ with \[REDACTED KEY\]/)
  })
})

describe('/conduct stats', () => {
  const base = { v: 1 as const, session: 'aaaa1111-s', project: '/p/app' }
  const at = (min: number) => new Date(DAY + min * 60_000).toISOString()
  const records: MetricRecord[] = [
    { ...base, at: at(0), kind: 'session.start', version: '1.2.0', platform: 'Linux', gateway: 'openrouter', enabled: true, workers: ['claude', 'codex'] },
    { ...base, at: at(1), kind: 'run.created', runId: 'r1', goal: 'g' },
    { ...base, at: at(2), kind: 'snapshot', runId: 'r1', runningJobs: 3, byExecutor: { claude: 2, codex: 1 }, worktrees: 3 },
    { ...base, at: at(5), kind: 'job.finished', runId: 'r1', taskId: 't1', job: 'implement', outcome: 'exited', exitCode: 0, durationMs: 120_000, executor: 'claude', tier: 'standard', model: 'anthropic/claude-sonnet-5.5' },
    { ...base, at: at(5), kind: 'node.finished', runId: 'r1', taskId: 't1', template: 'feature', node: 'implement', status: 'ok', to: 'check', costUsd: 0.8, tokensIn: 10_000, tokensOut: 2_000, reason: 'diff', executor: 'claude', tier: 'standard', model: 'anthropic/claude-sonnet-5.5' },
    { ...base, at: at(6), kind: 'job.finished', runId: 'r1', taskId: 't2', job: 'implement', outcome: 'timeout', exitCode: -1, durationMs: 600_000, executor: 'codex', tier: 'cheap', model: 'openai/gpt-5.1-codex-mini' },
    { ...base, at: at(6), kind: 'node.finished', runId: 'r1', taskId: 't2', template: 'solo', node: 'implement', status: 'fail', to: 'implement', rule: 'retry', reason: 'timeout', executor: 'codex', tier: 'cheap', model: 'openai/gpt-5.1-codex-mini' },
    { ...base, at: at(7), kind: 'node.finished', runId: 'r1', taskId: 't1', template: 'feature', node: 'review', status: 'ok', to: 'judge', costUsd: 0.2, reason: 'pass', executor: 'codex' },
    { ...base, at: at(8), kind: 'task.finished', runId: 'r1', taskId: 't1', template: 'feature', status: 'merged', attempts: 1, retries: 0, executors: ['claude'], models: ['anthropic/claude-sonnet-5.5'], costUsd: 1, tokens: 12_000, minutes: 8, reason: 'verified' },
    { ...base, at: at(9), kind: 'task.finished', runId: 'r1', taskId: 't2', template: 'solo', status: 'failed', attempts: 3, retries: 2, executors: ['codex'], models: ['openai/gpt-5.1-codex-mini'], costUsd: 0, tokens: 0, minutes: 30, reason: 'out of retries' },
    { ...base, at: at(9), kind: 'error', where: 'advance', message: 'git worktree add /home/deploy/.conductor/worktrees/app-1/r1/t2-3 failed: exit 128' },
    { ...base, at: at(9), kind: 'error', where: 'advance', message: 'git worktree add /home/deploy/.conductor/worktrees/app-1/r1/t3-1 failed: exit 128' },
    { ...base, session: 'bbbb2222-s', project: '/p/api', at: at(10), kind: 'run.finished', runId: 'r9', status: 'completed', tasks: 1, merged: 1, failed: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, minutes: 3 },
  ]

  it('adds up cost, tokens, success and time by worker, model, template and session', () => {
    const r = buildStats(records, DAY, DAY + 3_600_000)
    assert.equal(r.sessions, 2)
    assert.equal(r.projects, 2)
    assert.equal(r.runsCreated, 1)
    assert.equal(r.runsCompleted, 1)
    assert.equal(r.tasksMerged, 1)
    assert.equal(r.tasksFailed, 1)
    assert.equal(r.costUsd, 1)
    assert.equal(r.tokens, 12_000)
    assert.equal(r.peakJobs, 3)
    assert.equal(r.peakWorktrees, 3)
    assert.deepEqual(r.byExecutor.map(u => [u.key, u.jobs, u.ok, u.failed, u.costUsd]), [['claude', 1, 1, 0, 0.8], ['codex', 1, 0, 1, 0.2]])
    assert.deepEqual(r.byModel.map(u => u.key), ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.1-codex-mini'])
    assert.deepEqual(r.byTemplate.map(t => [t.template, t.merged, t.failed, t.retries]), [['feature', 1, 0, 0], ['solo', 0, 1, 2]])
    assert.deepEqual(r.bySession.map(s => [s.session, s.runs, s.jobs, s.costUsd]), [['aaaa1111-s', 1, 2, 1], ['bbbb2222-s', 0, 0, 0]])
    assert.deepEqual(r.errors, [{ message: errorShape('git worktree add /x failed: exit 128'), count: 2 }], 'the same error with other paths counts once')
  })

  it('reads as a report', () => {
    const text = statsText(buildStats(records, DAY, DAY + 3_600_000))
    assert.match(text, /^Conductor, 2026-11-03 to 2026-11-03/)
    assert.match(text, /2 session\(s\) in 2 project\(s\) · 1 run\(s\), 1 completed · 1\/2 task\(s\) merged \(50%\)/)
    assert.match(text, /at most 3 job\(s\) and 3 worktree\(s\) at once/)
    assert.match(text, /claude\s+1 job\(s\)\s+100% ok\s+2\.0 min\s+12k tok\s+US\$ 0\.80/)
    assert.match(text, /solo\s+0\/1 merged\s+3\.0 attempt\(s\) each\s+2 retries/)
    assert.match(text, /2×  git worktree add <path> failed: exit N/)
    assert.match(statsText(buildStats([], DAY, DAY)), /By worker:\n {2}\(none\)/)
  })
})

describe('what a run records', () => {
  it('runs, jobs, nodes, tasks and snapshots, with who did the work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-metrics-run-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'README.md'), '# demo\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
    process.env.FAKE_STATE_DIR = dir

    const host = nodeHost(dir, pluginRoot)
    const buffer = new AppendBuffer(host)
    const metrics = new MetricsLog(buffer, { dir: `${dir}/metrics`, session: 'run-session', project: dir })
    const config = parseConfig(JSON.stringify({ gateway: 'native', checks: ['true'], executors: { claude: { bin: fakeClaude } } }))
    const source = new LocalFileTaskSource(host, `${dir}/.conductor/tasks.json`)
    const c = new Conductor(host, source, new RuleDecisionModel(config.riskPaths), [new ClaudeExecutor(config.executors.claude)], config,
      { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined }, undefined, metrics)
    ;(c as unknown as { available: string[] }).available = ['claude']

    const runId = await c.createRun('two files')
    await c.plan(runId, [{ key: 'a', title: 'make a', description: 'create file a.txt', acceptance: ['a.txt exists'], files: ['a.txt'], labels: ['template:solo'] }])
    for (let i = 0; i < 200 && (await source.getRun(runId))?.status !== 'completed'; i++) {
      await c.tick(runId)
      await sleep(40)
    }
    assert.equal((await source.getRun(runId))?.status, 'completed')
    await buffer.flush()

    const records = await readMetrics(host, `${dir}/metrics`, 0)
    const kinds = new Set(records.map(r => r.kind))
    for (const kind of ['run.created', 'run.planned', 'job.started', 'job.finished', 'node.finished', 'task.finished', 'snapshot', 'run.finished'] as const) {
      assert.ok(kinds.has(kind), `no ${kind} recorded`)
    }
    const started = records.find(r => r.kind === 'job.started' && r.job === 'implement')
    assert.ok(started?.kind === 'job.started' && started.executor === 'claude' && started.provider === 'native' && started.attempt === 1)
    const implement = records.find(r => r.kind === 'node.finished' && r.node === 'implement')
    assert.ok(implement?.kind === 'node.finished' && implement.executor === 'claude' && implement.status === 'ok' && implement.tokensIn === 100)
    const task = records.find(r => r.kind === 'task.finished')
    assert.ok(task?.kind === 'task.finished' && task.status === 'merged' && task.template === 'solo' && task.executors.join() === 'claude')
    const finished = records.find(r => r.kind === 'run.finished')
    assert.ok(finished?.kind === 'run.finished' && finished.status === 'completed' && finished.merged === 1)
    assert.ok(records.every(r => r.session === 'run-session' && r.project === dir))
    assert.ok(!existsSync(`${dir}/conductor-plan.log`), 'nothing written outside the project and the ledger')
  })
})
