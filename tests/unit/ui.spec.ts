// The dashboard: its text helpers, its SVG charts, and the numbers the Conductor publishes for it.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { parseConfig } from '../../src/core/config.ts'
import { Conductor } from '../../src/core/conductor.ts'
import type { Attempt, Task } from '../../src/core/domain.types.ts'
import { bar, budgetLevel, elapsed, groupOf, nodeTrail, percent, STATUS_LOOK, tokens, trailText } from '../../src/ui/format.ts'
import { escapeXml, statusBarSvg, workerCostSvg } from '../../src/ui/svg.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('dashboard text', () => {
  it('bar: merged, running and the rest share the width; full only when all are merged', () => {
    const b = bar(8, 2, 12, 12)
    assert.equal(b.done.length + b.active.length + b.rest.length, 12)
    assert.equal(b.done, '████████')
    assert.equal(b.active, '▓▓')
    assert.equal(bar(11, 0, 12, 4).rest.length, 1, 'one task left keeps a cell empty')
    assert.equal(bar(12, 0, 12, 4).done, '████')
    assert.equal(bar(1, 0, 100, 10).done, '█', 'a part above zero gets a cell')
    assert.equal(bar(0, 0, 0, 5).rest, '░░░░░')
  })

  it('tokens, durations, budgets and percentages read short', () => {
    assert.deepEqual([tokens(950), tokens(12_400), tokens(120_000), tokens(1_234_567)], ['950', '12.4k', '120k', '1.2M'])
    const t0 = Date.parse('2026-11-03T10:00:00Z')
    assert.equal(elapsed('2026-11-03T10:00:00Z', t0 + 42_000), '42s')
    assert.equal(elapsed('2026-11-03T10:00:00Z', t0 + 192_000), '3m 12s')
    assert.equal(elapsed('2026-11-03T10:00:00Z', t0 + 3_900_000), '1h 05m')
    assert.equal(elapsed('not a date', t0), '')
    assert.deepEqual([budgetLevel(10, 50), budgetLevel(40, 50), budgetLevel(50, 50), budgetLevel(5, 0)], ['ok', 'warn', 'over', 'ok'])
    assert.equal(percent(8, 12), 66)
    assert.equal(percent(0, 0), 0)
  })

  it('every status has a look and a group', () => {
    assert.equal(STATUS_LOOK.needs_review.tone, 'warning')
    assert.deepEqual(['running', 'needs_review', 'ready', 'merged', 'cancelled'].map(s => groupOf(s as Task['status'])), ['running', 'review', 'queued', 'done', 'failed'])
  })

  it('the node trail marks where the task stands', () => {
    const steps = nodeTrail(['implement', 'check', 'review', 'merge'], 1)
    assert.deepEqual(steps.map(s => s.state), ['done', 'current', 'todo', 'todo'])
    assert.equal(trailText(steps), 'implement ▸ [check] ▸ review ▸ merge')
    assert.ok(nodeTrail(['a', 'b'], 2).every(s => s.state === 'done'), 'merged: every node done')
  })
})

describe('dashboard charts', () => {
  it('the status bar is one svg with a segment per state present and a legend for all', () => {
    const svg = statusBarSvg({ merged: 8, running: 2, review: 1, failed: 0, queued: 1 }, 400)
    assert.match(svg, /^<svg [^>]*viewBox="0 0 400 34"/)
    assert.ok(svg.endsWith('</svg>'))
    assert.equal((svg.match(/<rect x=/g) ?? []).length, 4, 'no segment for zero failures')
    assert.match(svg, /8 merged/)
    assert.match(svg, /0 failed/)
  })

  it('worker bars scale to the most expensive worker and escape their labels', () => {
    assert.equal(escapeXml(`a<b & "c"`), 'a&#60;b &#38; &#34;c&#34;')
    const svg = workerCostSvg([{ executor: 'claude', costUsd: 2, tokens: 120_000 }, { executor: 'codex', costUsd: 1, tokens: 950 }], 560)
    assert.match(svg, /US\$ 2\.00 · 120k tok/)
    assert.match(svg, /US\$ 1\.00 · 950 tok/)
    const widths = [...svg.matchAll(/<rect x="90" y="\d+" width="([\d.]+)" height="10" rx="5" fill="#d97757"/g)].map(m => Number(m[1]))
    assert.equal(widths.length, 2)
    assert.equal(widths[0], (widths[1] ?? 0) * 2)
  })
})

describe('dashboard data', () => {
  const attempt = (a: Partial<Attempt> & Pick<Attempt, 'executor'>): Attempt => ({
    tier: 'standard', worktree: '/w', branch: 'b', baseRef: 'HEAD', logDir: '/l', startedAt: '2026-11-03T10:00:00.000Z', ...a,
  })
  const task = (t: Partial<Task> & Pick<Task, 'title' | 'status'>): Task => ({
    id: '', runId: '', description: 'd', acceptance: ['a'], dependsOn: [], attempts: [], ...t,
  })

  it('summary sums tokens and cost per worker; board rows know their node and when they started running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-ui-'))
    const host = nodeHost(dir, pluginRoot)
    const source = new LocalFileTaskSource(host, `${dir}/.conductor/tasks.json`)
    const config = parseConfig(JSON.stringify({ gateway: 'native', budgets: { runUsd: 10, dayUsd: 40 } }))
    const c = new Conductor(host, source, new RuleDecisionModel(config.riskPaths), [], config,
      { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined })
    const { runId } = await source.createRun('ship the dashboard')
    await source.upsertTasks(runId, [
      task({
        runId, title: 'merged one', status: 'merged', template: 'feature', cursor: 'END',
        attempts: [
          attempt({ executor: 'claude', costUsd: 1.5, tokens: { input: 1000, output: 200 } }),
          attempt({ executor: 'codex', costUsd: 0.5, tokens: { input: 300, output: 100 } }),
        ],
      }),
      task({
        runId, title: 'running one', status: 'running', template: 'feature', cursor: 'check',
        attempts: [attempt({ executor: 'claude', tokens: { input: 50, output: 5 } })],
        job: { kind: 'check', dir: '/j', pid: 1, startedAt: '2026-11-03T10:05:00.000Z', timeoutMs: 1000 },
      }),
      task({ runId, title: 'waiting', status: 'ready' }),
    ])

    const s = await c.summary(runId)
    assert.ok(s)
    assert.equal(s.total, 3)
    assert.equal(s.merged, 1)
    assert.equal(s.running, 1)
    assert.equal(s.queued, 1)
    assert.equal(s.tokensIn, 1350)
    assert.equal(s.tokensOut, 305)
    assert.equal(s.costUsd, 2)
    assert.equal(s.budgetRunUsd, 10)
    assert.equal(s.budgetDayUsd, 40)
    assert.equal(s.goal, 'ship the dashboard')
    const claude = s.byWorker.find(w => w.executor === 'claude')
    assert.deepEqual(claude && { tasks: claude.tasks, attempts: claude.attempts, tokens: claude.tokens, costUsd: claude.costUsd, estimated: claude.estimated },
      { tasks: 2, attempts: 2, tokens: 1255, costUsd: 1.5, estimated: true })
    assert.equal(s.byWorker[0]?.executor, 'claude', 'most expensive first')

    const rows = c.boardRows(await source.listTasks(runId))
    const [merged, running, waiting] = rows
    assert.equal(merged?.nodeIndex, merged?.nodes.length, 'merged: past the last node')
    assert.equal(merged?.tokens, 1600)
    assert.equal(merged?.attempts, 2)
    assert.equal(running?.node, 'check')
    assert.equal(running?.nodes[running.nodeIndex], 'check')
    assert.equal(running?.runningSince, '2026-11-03T10:05:00.000Z')
    assert.equal(running?.executor, 'claude')
    assert.equal(waiting?.nodeIndex, -1)
    assert.equal(waiting?.runningSince, undefined)
  })
})
