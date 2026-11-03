// End to end with real git, the real scripts/job.sh and a fake worker CLI.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { CodexExecutor } from '../../src/adapters/executors/codex.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { Conductor } from '../../src/core/conductor.ts'
import type { Notifier } from '../../src/core/conductor.types.ts'
import { parseConfig } from '../../src/core/config.ts'
import type { ConductorConfig } from '../../src/core/config.types.ts'
import type { PlanInput, RunSummary } from '../../src/core/domain.types.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeClaude = join(pluginRoot, 'tests/support/fake-claude.sh')
chmodSync(fakeClaude, 0o755)
chmodSync(join(pluginRoot, 'scripts/job.sh'), 0o755)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-e2e-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}

function setup(over: Record<string, unknown> = {}) {
  const root = repo()
  process.env.FAKE_STATE_DIR = root
  const config: ConductorConfig = parseConfig(JSON.stringify({
    heartbeatMs: 50,
    // The fake worker stands in for a natively logged-in CLI; OpenRouter routing has its own tests.
    gateway: 'native',
    executors: {
      claude: { bin: fakeClaude }, codex: { bin: '/nonexistent/codex' }, opencode: { bin: '/nonexistent/opencode' },
      cursor: { enabled: false }, antigravity: { enabled: false },
    },
    ...over,
  }))
  const host = nodeHost(root, pluginRoot)
  const wakes: string[] = []
  const toasts: string[] = []
  let last: RunSummary | null = null
  const notifier: Notifier = {
    toast: t => toasts.push(t),
    wake: async t => {
      wakes.push(t)
    },
    summary: async s => {
      last = s
    },
    board: async () => undefined,
  }
  const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
  const conductor = new Conductor(host, source, new RuleDecisionModel(config.riskPaths),
    [new ClaudeExecutor(config.executors.claude), new CodexExecutor(config.executors.codex)], config, notifier)
  return { root, conductor, source, wakes, toasts, summary: () => last }
}

async function runUntil(conductor: Conductor, runId: string, done: () => Promise<boolean>, max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    await conductor.tick(runId)
    if (await done()) return
    await sleep(50)
  }
  throw new Error('run did not settle')
}

const plan = (key: string, extra: Partial<PlanInput> = {}): PlanInput => ({
  key, title: `make ${key}`, description: `create file ${key}.txt`, acceptance: [`${key}.txt exists`], files: [`${key}.txt`], ...extra,
})

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

describe('conductor end to end', () => {
  it('runs dependent tasks through checks and merges them into the integration branch', async () => {
    const { root, conductor, source, wakes, summary } = setup({ checks: ['test -f a.txt || test -f b.txt'] })
    assert.deepEqual(await conductor.detectExecutors(), ['claude'])
    const runId = await conductor.createRun('two files')
    await conductor.plan(runId, [plan('a'), plan('b', { dependsOn: ['a'] })])

    await runUntil(conductor, runId, async () => (await source.listTasks(runId)).every(t => t.status === 'merged'))

    const files = gitIn(root, 'ls-tree', '--name-only', `conductor/${runId}/integration`).split('\n')
    assert.ok(files.includes('a.txt') && files.includes('b.txt'))
    // b ran after a was merged: its worktree started from an integration head that had a.txt.
    const [ta, tb] = await source.listTasks(runId)
    assert.ok(tb && ta && Date.parse(tb.attempts[0]!.startedAt) >= Date.parse(ta.attempts[0]!.finishedAt!))
    assert.equal(gitIn(root, 'status', '--porcelain'), '', '.conductor/ stays out of the project status')
    assert.equal((await source.getRun(runId))?.status, 'completed')
    assert.equal(wakes.length, 1)
    assert.match(wakes[0]!, /completed/)
    assert.equal(summary()?.merged, 2)
    assert.ok(Math.abs((summary()?.costUsd ?? 0) - 0.04) < 1e-9)
  })

  it('retries a failed attempt on a higher tier', async () => {
    const { conductor, source } = setup({ checks: ['test -f c.txt'] })
    await conductor.detectExecutors()
    const runId = await conductor.createRun('retry')
    await conductor.plan(runId, [plan('c', { description: 'create file c.txt fail-once', labels: ['template:solo'] })])
    await runUntil(conductor, runId, async () => (await source.listTasks(runId))[0]?.status === 'merged')
    const [t] = await source.listTasks(runId)
    assert.equal(t?.attempts.length, 2)
    assert.equal(t?.attempts[0]?.error?.includes('simulated failure'), true)
    assert.notEqual(t?.attempts[0]?.tier, t?.attempts[1]?.tier)
  })

  it('without checks or reviewer, asks the maestro; approve merges', async () => {
    const { conductor, source, wakes } = setup()
    await conductor.detectExecutors()
    const runId = await conductor.createRun('review')
    await conductor.plan(runId, [plan('d')])
    await runUntil(conductor, runId, async () => (await source.listTasks(runId))[0]?.status === 'needs_review')
    assert.equal(wakes.length, 1)
    assert.match(wakes[0]!, /need your review/)
    const [t] = await source.listTasks(runId)
    assert.equal(await conductor.approve(t!.id), 'done')
    await runUntil(conductor, runId, async () => (await source.listTasks(runId))[0]?.status === 'merged')
  })

  it('fails a worker that changed nothing, and stops retrying when rejected', async () => {
    const { conductor, source, wakes } = setup({ maxRetries: 0 })
    await conductor.detectExecutors()
    const runId = await conductor.createRun('noop')
    await conductor.plan(runId, [plan('e', { description: 'do-nothing' })])
    await runUntil(conductor, runId, async () => (await source.listTasks(runId))[0]?.status === 'failed')
    const [t] = await source.listTasks(runId)
    assert.match(t?.note ?? '', /no changes/)
    await conductor.tick(runId)
    assert.match(wakes.at(-1) ?? '', /stuck/)
  })

  it('kills a job that outlives its timeout', async () => {
    const hang = join(mkdtempSync(join(tmpdir(), 'hang-')), 'hang.sh')
    writeFileSync(hang, '#!/bin/sh\nsleep 30\n')
    chmodSync(hang, 0o755)
    const { conductor, source } = setup({
      maxRetries: 0,
      timeouts: { implementMs: 300, checkMs: 1000, reviewMs: 1000 },
      executors: { claude: { bin: hang }, codex: { bin: '/nonexistent/codex' }, opencode: { bin: '/nonexistent/opencode' } },
    })
    // `hang.sh --version` hangs too, so availability is forced rather than detected.
    ;(conductor as unknown as { available: string[] }).available = ['claude']
    const runId = await conductor.createRun('timeout')
    await conductor.plan(runId, [plan('f')])
    await runUntil(conductor, runId, async () => (await source.listTasks(runId))[0]?.status === 'failed')
    const [t] = await source.listTasks(runId)
    assert.match(t?.note ?? '', /timeout/)
    const pid = Number(readFileSync(`${t!.attempts[0]!.logDir}/implement/pid`, 'utf8'))
    await sleep(300)
    assert.throws(() => process.kill(pid, 0), 'the worker process is gone')
  })
})
