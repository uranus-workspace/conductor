import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { AntigravityExecutor } from '../../src/adapters/executors/antigravity.ts'
import { CursorExecutor } from '../../src/adapters/executors/cursor.ts'
import type { Executor, ExecutorRequest } from '../../src/adapters/executors/executor.types.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { Conductor } from '../../src/core/conductor.ts'
import { applySwitches, DEFAULT_CONFIG, merge, parseConfig } from '../../src/core/config.ts'
import type { Host } from '../../src/core/host.types.ts'
import { nodeHost } from '../support/node-host.ts'

const req = (over: Partial<ExecutorRequest> = {}): ExecutorRequest => ({
  task: { id: 't', runId: 'r', title: 'x', description: 'y', acceptance: ['z'], dependsOn: [], status: 'ready', attempts: [] },
  worktree: '/wt', logDir: '/logs', prompt: 'PROMPT', mode: 'implement', timeoutMs: 900_000, ...over,
})

describe('switches', () => {
  it('the settings menu only turns things off', () => {
    const project = parseConfig(JSON.stringify({ executors: { codex: { enabled: false } } }))
    const c = applySwitches(project, { enabled: true, worker_cursor: false, worker_codex: true })
    assert.equal(c.enabled, true)
    assert.equal(c.executors.cursor.enabled, false)
    assert.equal(c.executors.codex.enabled, false, 'on in settings does not override the project off')
    assert.equal(c.executors.claude.enabled, true)
    assert.equal(applySwitches(DEFAULT_CONFIG, { enabled: false }).enabled, false)
    assert.equal(applySwitches(parseConfig('{"enabled": false}'), {}).enabled, false)
  })

  it('a switched-off worker is never probed and leaves routing', async () => {
    const probed: string[] = []
    const fake = (id: 'claude' | 'codex', enabled: boolean): Executor => ({
      id, config: { ...DEFAULT_CONFIG.executors[id], enabled },
      available: async () => (probed.push(id), { ok: true as const }),
      command: () => ({ argv: [] }),
      collect: async () => ({ ok: true, exitCode: 0, summary: '' }),
    })
    const host = { cwd: '/x', pluginRoot: '/p' } as Host
    const c = new Conductor(host, {} as LocalFileTaskSource, new RuleDecisionModel([]), [fake('claude', true), fake('codex', false)], DEFAULT_CONFIG,
      { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined })
    assert.deepEqual(await c.detectExecutors(), ['claude'])
    assert.deepEqual(probed, ['claude'])
    assert.deepEqual(c.workers, [
      { id: 'claude', enabled: true, installed: true, reason: undefined },
      { id: 'codex', enabled: false, installed: undefined, reason: undefined },
    ])
  })

  it('a switched-off Conductor refuses a plan and its heartbeat does nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'off-'))
    const host = nodeHost(dir, dir)
    const source = new LocalFileTaskSource(host, `${dir}/tasks.json`)
    const config = merge(DEFAULT_CONFIG, { enabled: false })
    const c = new Conductor(host, source, new RuleDecisionModel([]), [], config,
      { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined })
    const runId = await c.createRun('goal')
    await assert.rejects(c.plan(runId, [{ key: 'a', title: 'a', description: 'a', acceptance: ['a'] }]), /switched off/)
    await source.updateRun(runId, { status: 'active' })
    await source.upsertTasks(runId, [{ id: '', runId, title: 'a', description: 'a', acceptance: ['a'], dependsOn: [], status: 'planned', attempts: [] }])
    await c.tick(runId)
    assert.equal((await source.listTasks(runId))[0]?.status, 'planned')
  })
})

describe('CursorExecutor', () => {
  it('forces edits only when implementing and accepts a split binary', () => {
    const ex = new CursorExecutor(merge(DEFAULT_CONFIG.executors.cursor, { bin: 'cursor', binArgs: ['agent'] }))
    const impl = ex.command(req({ model: 'gpt-5' }))
    assert.deepEqual(impl.argv.slice(0, 4), ['cursor', 'agent', '-p', '--force'])
    assert.equal(impl.argv.at(-1), 'PROMPT')
    assert.ok(!ex.command(req({ mode: 'review' })).argv.includes('--force'))
  })

  it('reads the result field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cu-'))
    await writeFile(join(dir, 'out.log'), JSON.stringify({ type: 'result', is_error: false, result: 'edited 12 files' }))
    const r = await new CursorExecutor(DEFAULT_CONFIG.executors.cursor).collect(nodeHost(dir, dir), dir, 0)
    assert.equal(r.ok, true)
    assert.equal(r.summary, 'edited 12 files')
  })
})

describe('AntigravityExecutor', () => {
  it('stretches its print timeout to ours and maps the permission mode', () => {
    const ex = new AntigravityExecutor(DEFAULT_CONFIG.executors.antigravity)
    const argv = ex.command(req({ model: 'gemini-3-pro' })).argv
    assert.deepEqual(argv.slice(0, 3), ['agy', '-p', 'PROMPT'])
    assert.equal(argv[argv.indexOf('--print-timeout') + 1], '900s')
    assert.equal(argv[argv.indexOf('--mode') + 1], 'accept-edits')
    assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3-pro')
    assert.equal(ex.command(req({ mode: 'review' })).argv[argv.indexOf('--mode') + 1], 'plan')
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] as string) as { permissions: { allow: string[] } }
    assert.ok(settings.permissions.allow.includes('write_file(/wt/**)'))
    assert.ok(settings.permissions.allow.includes('command(git diff)'))
    const withChecks = ex.command(req({ checks: ['npm test'] })).argv
    assert.ok((withChecks[withChecks.indexOf('--settings') + 1] as string).includes('command(npm test)'))
    const tmp = ex.command(req({ worktree: '/var/folders/x/wt' })).argv
    assert.ok((tmp[tmp.indexOf('--settings') + 1] as string).includes('write_file(/private/var/folders/x/wt/**)'))
    const skip = new AntigravityExecutor(merge(DEFAULT_CONFIG.executors.antigravity, { permissionMode: 'skip' }))
    assert.ok(skip.command(req()).argv.includes('--dangerously-skip-permissions'))
  })

  it('reads the JSON agy prints and fails on any other status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ag-'))
    const ex = new AntigravityExecutor(DEFAULT_CONFIG.executors.antigravity)
    await writeFile(join(dir, 'out.log'), '{"conversation_id":"c","status":"SUCCESS","response":"done\\n","usage":{"input_tokens":100,"output_tokens":7,"thinking_tokens":3}}')
    const ok = await ex.collect(nodeHost(dir, dir), dir, 0)
    assert.equal(ok.ok, true)
    assert.equal(ok.summary, 'done')
    assert.deepEqual(ok.tokens, { input: 100, output: 10 })
    await writeFile(join(dir, 'out.log'), '{"status":"SUCCESS","response":"","denied_actions":[{"action":"write_file"}]}')
    assert.match((await ex.collect(nodeHost(dir, dir), dir, 0)).error ?? '', /denied: write_file/)
    await writeFile(join(dir, 'out.log'), '{"status":"TIMEOUT","response":""}')
    const bad = await ex.collect(nodeHost(dir, dir), dir, 0)
    assert.equal(bad.ok, false)
    assert.match(bad.error ?? '', /TIMEOUT/)
  })
})
