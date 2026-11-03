// Phase 2: OpenRouter worker end to end, reconciliation, day budget, worktree cleanup, redaction.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { OpenRouterExecutor, stripFence } from '../../src/adapters/executors/openrouter.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { Conductor } from '../../src/core/conductor.ts'
import type { Notifier } from '../../src/core/conductor.types.ts'
import { parseConfig } from '../../src/core/config.ts'
import { isCnpj, isCpf, redact } from '../../src/core/redact.ts'
import type { BoardRow } from '../../src/core/domain.types.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
chmodSync(join(pluginRoot, 'scripts/job.sh'), 0o755)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-p2-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}

const quiet = (boards: BoardRow[][] = []): Notifier => ({
  toast: () => undefined,
  wake: async () => undefined,
  summary: async () => undefined,
  board: async rows => {
    boards.push(rows)
  },
})

describe('OpenRouter worker (curl in a detached job)', () => {
  let url = ''
  const seen: Array<{ auth?: string; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { content: '```markdown\n# Glossary\n\n- run: a goal\n```' } }],
        usage: { prompt_tokens: 40, completion_tokens: 12, cost: 0.0004 },
      }))
    })
  })
  before(async () => {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })
  after(() => server.close())

  it('writes the answer into the declared file, commits and merges it', async () => {
    const root = repo()
    const config = parseConfig(JSON.stringify({ heartbeatMs: 50, checks: ['grep -q Glossary docs/glossary.md'] }))
    const host = nodeHost(root, pluginRoot, { openrouterKey: 'sk-or-test-key-123456789' })
    const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
    const c = new Conductor(host, source, new RuleDecisionModel(config.riskPaths),
      [new OpenRouterExecutor(config.executors.openrouter, url, 'openai/gpt-4o-mini')], config, quiet())
    assert.deepEqual(await c.detectExecutors(), ['openrouter'])
    const runId = await c.createRun('docs')
    await c.plan(runId, [{
      key: 'g', title: 'Glossary', description: 'Write a glossary. Contact: CPF 529.982.247-25',
      acceptance: ['has a heading'], files: ['docs/glossary.md'], labels: ['executor:openrouter'],
    }])
    for (let i = 0; i < 100 && (await source.listTasks(runId))[0]?.status !== 'merged'; i++) {
      await c.tick(runId)
      await sleep(50)
    }
    const [t] = await source.listTasks(runId)
    assert.equal(t?.status, 'merged', t?.note ?? 'no note')
    const merged = execFileSync('git', ['show', `conductor/${runId}/integration:docs/glossary.md`], { cwd: root, encoding: 'utf8' })
    assert.equal(merged, '# Glossary\n\n- run: a goal\n', 'fence stripped, newline added')
    assert.equal(t?.attempts[0]?.costUsd, 0.0004)
    assert.equal(seen[0]?.auth, 'Bearer sk-or-test-key-123456789')
    assert.ok(!seen[0]?.body.includes('529.982.247-25'), 'CPF redacted before leaving')
  })
})

describe('reconciliation', () => {
  it('requeues a task dispatched without a process and kills an orphan worker', async () => {
    const root = repo()
    const host = nodeHost(root, pluginRoot)
    const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
    const config = parseConfig(undefined)
    const c = new Conductor(host, source, new RuleDecisionModel([]), [new ClaudeExecutor(config.executors.claude)], config, quiet())
    const runId = await c.createRun('r')
    await source.updateRun(runId, { status: 'active' })
    const [t] = await source.upsertTasks(runId, [{ id: '', runId, title: 't', description: 'd', acceptance: ['a'], dependsOn: [], status: 'planned', attempts: [] }])
    await source.transition(t!.id, 'classified')
    await source.transition(t!.id, 'ready')
    await source.transition(t!.id, 'dispatched')

    // An orphan: a process with a log folder no task owns.
    const dir = join(root, '.conductor/logs', runId, 'ghost', '1', 'implement')
    mkdirSync(dir, { recursive: true })
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    writeFileSync(join(dir, 'pid'), String(child.pid))

    const res = await c.reconcile(runId)
    assert.deepEqual(res, { requeued: 1, killed: 1 })
    assert.equal((await source.listTasks(runId))[0]?.status, 'ready')
    await sleep(200)
    assert.throws(() => process.kill(child.pid as number, 0))
  })
})

describe('budgets', () => {
  it('stops dispatching once today\'s spend reaches the day budget', async () => {
    const root = repo()
    const host = nodeHost(root, pluginRoot)
    const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
    const config = parseConfig(JSON.stringify({ budgets: { dayUsd: 1 } }))
    const boards: BoardRow[][] = []
    const c = new Conductor(host, source, new RuleDecisionModel([]), [new ClaudeExecutor({ ...config.executors.claude, bin: '/bin/echo' })], config, quiet(boards))
    ;(c as unknown as { available: string[] }).available = ['claude']
    // An earlier run today already spent US$ 1,50.
    const old = await c.createRun('old')
    await source.upsertTasks(old, [{
      id: '', runId: old, title: 'x', description: 'x', acceptance: ['x'], dependsOn: [], status: 'cancelled',
      attempts: [{ executor: 'claude', tier: 'cheap', worktree: '/x', branch: 'b', baseRef: 'r', logDir: '/l', startedAt: new Date().toISOString(), costUsd: 1.5 }],
    }])
    await source.updateRun(old, { status: 'stopped' })
    const runId = await c.createRun('new')
    await c.plan(runId, [{ key: 'a', title: 'a', description: 'create file a.txt', acceptance: ['a'] }])
    await c.tick(runId)
    assert.equal(await c.spentToday(), 1.5)
    assert.equal((await source.listTasks(runId))[0]?.status, 'ready', 'classified and ready, not dispatched')
    assert.ok(boards.length > 0, 'the board is published on every tick')
  })
})

describe('redaction', () => {
  it('masks valid CPF/CNPJ and known secret formats, leaves other numbers', () => {
    assert.ok(isCpf('529.982.247-25'))
    assert.ok(!isCpf('111.111.111-11'))
    assert.ok(isCnpj('11.222.333/0001-81'))
    const out = redact('cpf 52998224725 cnpj 11.222.333/0001-81 pedido 12345678901 key sk-ant-api03-abcdefghijklmnopqrstuv OPENROUTER_API_KEY=sk-or-xyz123456')
    assert.match(out, /cpf \[CPF\]/)
    assert.match(out, /cnpj \[CNPJ\]/)
    assert.match(out, /pedido 12345678901/)
    assert.ok(!out.includes('abcdefghijklmnopqrstuv'))
    assert.ok(!out.includes('xyz123456'))
  })

  it('stripFence unwraps one fenced answer only', () => {
    assert.equal(stripFence('```ts\nconst a = 1\n```'), 'const a = 1')
    assert.equal(stripFence('text\n```x```'), 'text\n```x```')
  })
})

describe('worktree cleanup', () => {
  it('a retry removes the previous attempt\'s worktree', async () => {
    const root = repo()
    const fail = join(mkdtempSync(join(tmpdir(), 'w-')), 'fail.sh')
    writeFileSync(fail, '#!/bin/sh\necho \'{"is_error":true,"result":"no"}\'\nexit 1\n')
    chmodSync(fail, 0o755)
    const host = nodeHost(root, pluginRoot)
    const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
    const config = parseConfig(JSON.stringify({ maxRetries: 1 }))
    const c = new Conductor(host, source, new RuleDecisionModel([]), [new ClaudeExecutor({ ...config.executors.claude, bin: fail })], config, quiet())
    ;(c as unknown as { available: string[] }).available = ['claude']
    const runId = await c.createRun('w')
    await c.plan(runId, [{ key: 'a', title: 'a', description: 'a', acceptance: ['a'] }])
    for (let i = 0; i < 100; i++) {
      await c.tick(runId)
      const [t] = await source.listTasks(runId)
      if (t?.status === 'failed' && t.attempts.length === 2) break
      await sleep(50)
    }
    const [t] = await source.listTasks(runId)
    assert.equal(t?.attempts.length, 2)
    assert.equal(existsSync(t!.attempts[0]!.worktree), false)
    assert.equal(existsSync(t!.attempts[1]!.worktree), true, 'the last attempt stays for inspection')
  })
})
