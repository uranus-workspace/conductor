// Phase 4: Uranus OS as the task source over a simulated MCP server with the real envelope.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LabelRecord } from '../../src/adapters/decision/decision.types.ts'
import type { JevDecisionModel } from '../../src/adapters/decision/jev.ts'
import { DecisionLog, DecisionRouter } from '../../src/adapters/decision/router.ts'
import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { checkUranus, findUranusServer, labelsOf, STATUS, UranusOSTaskSource } from '../../src/adapters/task-source/uranus-os.ts'
import { Conductor } from '../../src/core/conductor.ts'
import { parseConfig } from '../../src/core/config.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeClaude = join(pluginRoot, 'tests/support/fake-claude.sh')
chmodSync(fakeClaude, 0o755)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Answers like the Uranus OS MCP server: `{ tool, trust, data }`. */
function fakeUranus() {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = []
  const tasks = new Map<string, { status: string; labels: string[]; epic?: string }>()
  let n = 0
  const envelope = (tool: string, data: unknown) => ({ text: JSON.stringify({ tool, trust: 'data', data }), isError: false })
  const mcp = async (server: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ server, tool, args })
    switch (tool) {
      case 'epics_create':
        return envelope(tool, { slug: 'run-epic', name: args.name, project_key: args.project_key, status: args.status })
      case 'tasks_create': {
        const key = `TST-${++n}`
        tasks.set(key, { status: 'backlog', labels: args.labels as string[], epic: args.epic_slug as string })
        return envelope(tool, { key, status: 'backlog' })
      }
      case 'tasks_batch': {
        const ops = args.operations as Array<{ op: string; key: string; status?: string; labels?: string[] }>
        for (const op of ops) {
          const t = tasks.get(op.key)
          if (t && op.op === 'transition' && op.status) t.status = op.status
          if (t && op.op === 'update' && op.labels) t.labels = op.labels
        }
        return envelope(tool, { results: ops.map(o => ({ key: o.key })), succeeded: ops.length, failed: 0 })
      }
      case 'tasks_update': {
        const t = tasks.get(args.key as string)
        if (t && args.labels) t.labels = args.labels as string[]
        return envelope(tool, { key: args.key })
      }
      case 'tasks_search': {
        const rows = [...tasks].filter(([, t]) => t.status === args.status).map(([key, t]) => ({ key, status: t.status }))
        return envelope(tool, { rows, total: rows.length })
      }
      case 'tasks_relate':
      case 'tasks_comment':
      case 'epics_update':
      case 'project_updates_publish':
        return envelope(tool, { ok: true })
      default:
        return { text: `unknown tool ${tool}`, isError: true }
    }
  }
  return { calls, tasks, mcp }
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-uos-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}

const quiet = { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined }

describe('UranusOSTaskSource', () => {
  it('maps a whole run onto an epic, tasks, relations, statuses, comments and updates', async () => {
    const root = repo()
    process.env.FAKE_STATE_DIR = root
    const uos = fakeUranus()
    const host = nodeHost(root, pluginRoot, { mcp: uos.mcp })
    const config = parseConfig(JSON.stringify({ checks: ['true'], executors: { claude: { bin: fakeClaude } } }))
    const source = new UranusOSTaskSource(host, new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`), {
      server: 'Uranus', projectKey: 'TST', pullCancellations: true,
    })
    // Jev in shadow, so labels are recorded on the way.
    const log = new DecisionLog(host, `${root}/.conductor/jev`)
    const decision = new DecisionRouter({
      host, rules: new RuleDecisionModel(config.riskPaths), mode: 'shadow', log, riskPaths: config.riskPaths,
      jev: { classify: async () => { throw new Error('offline') }, isVerified: async () => { throw new Error('offline') } } as unknown as JevDecisionModel,
    })
    const c = new Conductor(host, source, decision, [new ClaudeExecutor(config.executors.claude)], config, quiet)
    ;(c as unknown as { available: string[] }).available = ['claude']

    const runId = await c.createRun('Two files, CPF 529.982.247-25')
    await c.plan(runId, [
      { key: 'a', title: 'make a', description: 'create file a.txt', acceptance: ['a.txt exists'], files: ['a.txt'] },
      { key: 'b', title: 'make b', description: 'create file b.txt', acceptance: ['b.txt exists'], files: ['b.txt'], dependsOn: ['a'] },
    ])
    for (let i = 0; i < 200 && (await source.getRun(runId))?.status !== 'completed'; i++) {
      await c.tick(runId)
      await sleep(50)
    }
    assert.equal((await source.getRun(runId))?.status, 'completed')

    const by = (tool: string) => uos.calls.filter(x => x.tool === tool)
    assert.ok(uos.calls.every(x => x.server === 'Uranus'))
    assert.equal(by('epics_create').length, 1)
    assert.ok(!String(by('epics_create')[0]?.args.name).includes('529.982.247-25'), 'CPF redacted before it reaches the board')
    assert.equal(by('tasks_create').length, 2)
    assert.equal(by('tasks_create')[0]?.args.epic_slug, 'run-epic')
    assert.deepEqual(by('tasks_relate').map(x => x.args), [{ key: 'TST-1', related_key: 'TST-2', type: 'blocks' }])
    for (const [, t] of uos.tasks) {
      assert.equal(t.status, 'done')
      assert.ok(t.labels.includes('conductor:merged'))
      assert.ok(t.labels.some(l => l.startsWith('executor:')))
    }
    const comments = by('tasks_comment').map(x => String(x.args.body))
    assert.ok(comments.some(b => b.startsWith('**done** — checks passed')), 'the edge into merge')
    assert.ok(comments.some(b => b.startsWith('**merged** — merged conductor/')), 'the attempt\'s branch')
    assert.deepEqual(by('epics_update').at(-1)?.args, { project_key: 'TST', epic_slug: 'run-epic', status: 'done', confirm_open_tasks: true })
    assert.equal(by('project_updates_publish').length, 1)

    // Local state keeps what only this machine needs, keyed to the board.
    const tasks = await source.listTasks(runId)
    assert.deepEqual(tasks.map(t => t.remoteKey), ['TST-1', 'TST-2'])

    // Jev labels: one per task, both clean first tries.
    const labels = (await log.readAll()).filter((r): r is LabelRecord => r.kind === 'label')
    assert.equal(labels.length, 2)
    assert.ok(labels.every(l => l.cleanFirstTry))
  })

  it('a cancellation on the board cancels the task here and kills its worker', async () => {
    const root = repo()
    const hang = join(mkdtempSync(join(tmpdir(), 'hang-')), 'hang.sh')
    writeFileSync(hang, '#!/bin/sh\nsleep 30\n')
    chmodSync(hang, 0o755)
    const uos = fakeUranus()
    let now = Date.now()
    const host = nodeHost(root, pluginRoot, { mcp: uos.mcp, now: () => now })
    const config = parseConfig(JSON.stringify({ executors: { claude: { bin: hang } } }))
    const source = new UranusOSTaskSource(host, new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`), {
      server: 'Uranus', projectKey: 'TST', pullCancellations: true,
    })
    const c = new Conductor(host, source, new RuleDecisionModel([]), [new ClaudeExecutor(config.executors.claude)], config, quiet)
    ;(c as unknown as { available: string[] }).available = ['claude']
    const runId = await c.createRun('cancel me')
    await c.plan(runId, [{ key: 'a', title: 'a', description: 'a', acceptance: ['a'] }])
    await c.tick(runId)
    const [running] = await source.listTasks(runId)
    assert.equal(running?.status, 'running')

    uos.tasks.get('TST-1')!.status = 'cancelled' // someone cancels it on the board
    now += 31_000
    await c.tick(runId)
    const [t] = await source.listTasks(runId)
    assert.equal(t?.status, 'cancelled')
    assert.equal(t?.job, undefined)
    await sleep(200)
    const pid = running!.job!.pid
    assert.throws(() => process.kill(pid, 0), 'worker killed')
  })

  it('fails a transition the board refuses, so it is not considered made', async () => {
    const root = repo()
    const uos = fakeUranus()
    const refusing = async (server: string, tool: string, args: Record<string, unknown>) =>
      tool === 'tasks_batch' ? { text: 'forbidden: tasks.transition', isError: true } : uos.mcp(server, tool, args)
    const host = nodeHost(root, pluginRoot, { mcp: refusing })
    const local = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
    const source = new UranusOSTaskSource(host, local, { server: 'Uranus', projectKey: 'TST', pullCancellations: false })
    const { runId } = await source.createRun('g')
    const [t] = await source.upsertTasks(runId, [{ id: '', runId, title: 't', description: 'd', acceptance: ['a'], dependsOn: [], status: 'planned', attempts: [] }])
    await assert.rejects(source.transition(t!.id, 'classified'), /forbidden/)
    assert.equal((await local.getTask(t!.id))?.status, 'planned')
  })

  it('status map and labels follow the board of doc §13', () => {
    assert.equal(STATUS.ready, 'todo')
    assert.equal(STATUS.verifying, 'in_progress')
    assert.equal(STATUS.needs_review, 'review')
    assert.equal(STATUS.merged, 'done')
    assert.equal(STATUS.failed, 'blocked')
    const labels = labelsOf({
      id: 'x', runId: 'r', title: 't', description: 'd', acceptance: [], dependsOn: [], status: 'running', attempts: [],
      classification: { executor: 'codex', tier: 'standard', complexity: 3, risk: 2, parallelizable: 1, needsHuman: 0, source: 'rules' },
    })
    assert.deepEqual(labels, ['conductor', 'conductor:running', 'executor:codex', 'tier:standard', 'risk:2'])
  })

  it('finds the Uranus OS server by its tools, whatever the connector is called', () => {
    const tools = [
      'Read', 'mcp__claude_ai_Slack__send_message', 'mcp__claude_ai_Linear__create_issue',
      'mcp__ceb7094e-490a-4df2-b625-8af879e1bfd5__epics_create', 'mcp__ceb7094e-490a-4df2-b625-8af879e1bfd5__tasks_batch',
      'mcp__ceb7094e-490a-4df2-b625-8af879e1bfd5__project_updates_publish', 'mcp__ceb7094e-490a-4df2-b625-8af879e1bfd5__whoami',
    ]
    assert.equal(findUranusServer(tools), 'ceb7094e-490a-4df2-b625-8af879e1bfd5')
    assert.equal(findUranusServer(['mcp__x__epics_create']), undefined)
  })

  it('checks the connection read-only', async () => {
    const calls: string[] = []
    const host = nodeHost('/tmp', pluginRoot, {
      mcp: async (_server, tool) => {
        calls.push(tool)
        const data = tool === 'whoami'
          ? { issuer_email: 'dev@uranus.com.br', issuer_role: 'owner', scope: ['epics.create', 'tasks.create', 'tasks.transition', 'tasks.comment'] }
          : { rows: [{ name: 'Onboarding', status: 'planned' }], total: 1 }
        return { text: JSON.stringify({ tool, trust: 'data', data }), isError: false }
      },
    })
    const text = await checkUranus(host, { server: 'srv', projectKey: 'TESTE', pullCancellations: false })
    assert.deepEqual(calls, ['whoami', 'epics_list'])
    assert.match(text, /dev@uranus.com.br \(owner\)/)
    assert.match(text, /missing permissions: projects.update/)
    assert.match(text, /project TESTE: 1 epic/)
  })
})
