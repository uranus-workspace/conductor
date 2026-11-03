import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConductorBoardRow, ConductorGraph, ConductorSummary } from '../types'
import type { DecisionMode } from '../src/core/config.types.ts'
import { JevClient, JevDecisionModel } from '../src/adapters/decision/jev.ts'
import { buildReport, reportText } from '../src/adapters/decision/report.ts'
import { DecisionLog, DecisionRouter } from '../src/adapters/decision/router.ts'
import { RuleDecisionModel } from '../src/adapters/decision/rules.ts'
import { AntigravityExecutor } from '../src/adapters/executors/antigravity.ts'
import { ClaudeExecutor } from '../src/adapters/executors/claude.ts'
import { CodexExecutor } from '../src/adapters/executors/codex.ts'
import { CursorExecutor } from '../src/adapters/executors/cursor.ts'
import { OpenCodeExecutor } from '../src/adapters/executors/opencode.ts'
import { OpenRouterExecutor } from '../src/adapters/executors/openrouter.ts'
import { openrouterComplete } from '../src/adapters/openrouter.ts'
import { LocalFileTaskSource } from '../src/adapters/task-source/local-file.ts'
import type { TaskSource } from '../src/adapters/task-source/task-source.types.ts'
import { FigmaDesignSource, findFigmaServer } from '../src/adapters/design/figma.ts'
import { toolsOf } from '../src/adapters/mcp/mcp.ts'
import type { Board } from '../src/adapters/task-source/board.types.ts'
import { findJiraServer, JiraBoard } from '../src/adapters/task-source/jira.ts'
import { findLinearServer, LinearBoard } from '../src/adapters/task-source/linear.ts'
import { RemoteTaskSource } from '../src/adapters/task-source/remote-task-source.ts'
import { findUranusServer, UranusBoard } from '../src/adapters/task-source/uranus-os.ts'
import { applySwitches, isWorker, parseConfig, workerOption } from '../src/core/config.ts'
import type { ConductorConfig, SwitchOptions } from '../src/core/config.types.ts'
import { WORKERS } from '../src/core/constants.ts'
import { Conductor } from '../src/core/conductor.ts'
import type { Host } from '../src/core/host.types.ts'
import { redact } from '../src/core/redact.ts'
import type { WorkerId } from '../src/core/domain.types.ts'
import { hostOf, realPath } from '../src/mod/host.ts'
import type { SessionSetup } from '../src/mod/setup.types.ts'
import {
  parseApproveInput, parseAskOpenRouterInput, parseDispatchInput, parsePlanInput, parseRejectInput, parseStatusInput,
} from '../src/mod/tool-inputs.ts'
import { planningPrompt } from '../src/prompts/planning.ts'
import { band, dashboard } from './views.tsx'

// Bump a shape when the value's fields change: what older code stored then reads as absent.
const summary = atom({ plugin: 'conductor', key: 'summary' } as const, null as ConductorSummary | null, { shape: 'summary-2' })
const boardRows = atom({ plugin: 'conductor', key: 'board' } as const, [] as ConductorBoardRow[], { shape: 'board-2' })

const PANE = 'conductor-board'
const GRAPH_PANE = 'conductor-graph'
const graphView = atom({ plugin: 'conductor', key: 'graph' } as const, null as ConductorGraph | null)

const SUBCOMMANDS = 'plan <goal> | run | status | graph <taskId> | pause | stop | retry <taskId> [worker] | cost | on | off | workers | worker <id> on|off | key [status|remove] | source | figma <url> | jev | handoff'
const USAGE = `Usage: /conduct ${SUBCOMMANDS}`

const TASK_SCHEMA = {
  type: 'object',
  required: ['key', 'title', 'description', 'acceptance'],
  properties: {
    key: { type: 'string', description: 'Stable local key, referenced by dependsOn' },
    title: { type: 'string' },
    description: { type: 'string', description: 'What to do, with enough context for a worker that has not read this conversation' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Verifiable acceptance criteria' },
    files: { type: 'array', items: { type: 'string' }, description: 'Files the task will most likely touch (repo-relative)' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of tasks that must be merged first' },
    labels: { type: 'array', items: { type: 'string' }, description: 'e.g. "executor:claude" to force a worker' },
    client: { type: 'string', description: 'Client the cost is billed to' },
    designRefs: { type: 'array', items: { type: 'string' }, description: 'Figma links (figma.com/design/...?node-id=...) the worker should implement from' },
  },
}

const HANDOFF_PROMPT = `Write a handoff note for whoever continues this Conductor run after a /clear or in another session.
In under 300 words: the goal, what is merged, what is running, what waits for review and why, decisions taken in this conversation that the task board does not hold, and the next step. Plain Markdown, no preamble.`

const OFF = 'The Conductor is switched off. Turn it on with /conduct on.'

async function build(
  $: EngineInterface,
  host: Host,
  config: ConductorConfig,
  onBoard: (rows: ConductorBoardRow[]) => void,
  toolNames: readonly string[],
): Promise<{ conductor: Conductor; router: DecisionRouter; source: TaskSource; board: Board | undefined }> {
  const local = new LocalFileTaskSource(host, `${host.cwd}/.conductor/tasks.json`)
  const board = boardFor(host, config, toolNames)
  const source: TaskSource = board ? new RemoteTaskSource(host, local, board, config.taskSource.kind === 'uranus' ? config.taskSource.uranus.pullCancellations : true) : local

  // Jev is reached through OpenRouter: without the key there is nothing to shadow.
  const hasJev = config.decision.mode !== 'rules' && Boolean(await host.openrouterKey())
  const router = new DecisionRouter({
    host,
    rules: new RuleDecisionModel(config.riskPaths),
    jev: hasJev ? new JevDecisionModel(new JevClient(host, config.jev), config.riskPaths) : undefined,
    mode: config.decision.mode,
    thresholds: config.decision.thresholds,
    monitorRate: config.decision.monitorRate,
    log: new DecisionLog(host, `${host.cwd}/.conductor/jev`),
    riskPaths: config.riskPaths,
  })

  const conductor = new Conductor(
    host,
    source,
    router,
    [
      new ClaudeExecutor(config.executors.claude),
      new CodexExecutor(config.executors.codex),
      new OpenCodeExecutor(config.executors.opencode, config.openrouter.defaultModel),
      new CursorExecutor(config.executors.cursor),
      new AntigravityExecutor(config.executors.antigravity),
      new OpenRouterExecutor(config.executors.openrouter, config.openrouter.baseUrl, config.openrouter.defaultModel),
    ],
    config,
    {
      toast: text => $.ui.toast(text),
      wake: async text => {
        await $.prompt.submit({ text })
      },
      summary: async value => {
        await update($, summary, () => value)
      },
      board: async rows => {
        onBoard(rows)
        await update($, boardRows, () => rows)
      },
    },
    config.figma.server !== '' && config.figma.server !== 'auto' ? new FigmaDesignSource(host, config.figma) : undefined,
  )
  return { conductor, router, source, board }
}

/** The board the config names, when its MCP server was found in the session; undefined → the local file. */
function boardFor(host: Host, config: ConductorConfig, toolNames: readonly string[]): Board | undefined {
  const ts = config.taskSource
  switch (ts.kind) {
    case 'uranus':
      return ts.uranus.projectKey && ts.uranus.server !== 'auto' ? new UranusBoard(host, ts.uranus) : undefined
    case 'jira':
      return ts.jira.projectKey && ts.jira.server !== 'auto' ? new JiraBoard(host, ts.jira, toolsOf(toolNames, ts.jira.server)) : undefined
    case 'linear':
      return ts.linear.team && ts.linear.server !== 'auto' ? new LinearBoard(host, ts.linear, toolsOf(toolNames, ts.linear.server)) : undefined
    case 'local':
      return undefined
  }
}

/** Every `auto` MCP server in the config, resolved against the session's tools (still `auto` when absent). */
function resolveServers(config: ConductorConfig, toolNames: readonly string[]): ConductorConfig {
  const pick = (current: string, find: (names: readonly string[]) => string | undefined) => (current === 'auto' ? find(toolNames) ?? 'auto' : current)
  const ts = config.taskSource
  return {
    ...config,
    taskSource: {
      ...ts,
      uranus: { ...ts.uranus, server: pick(ts.uranus.server, findUranusServer) },
      jira: { ...ts.jira, server: pick(ts.jira.server, findJiraServer) },
      linear: { ...ts.linear, server: pick(ts.linear.server, findLinearServer) },
    },
    figma: { ...config.figma, server: config.figma.server === '' ? '' : pick(config.figma.server, findFigmaServer) },
  }
}

/** Builds the Conductor for a session: config, switches, task source, decisions, workers. */
async function setUp(
  $: EngineInterface,
  sessionCwd: string,
  options: SwitchOptions,
  onBoard: (rows: ConductorBoardRow[]) => void,
): Promise<SessionSetup> {
  // Real paths: some workers refuse a working directory spelled through a symlink.
  const cwd = await realPath($, sessionCwd)
  const home = await realPath($, (await $.env.get('HOME')) ?? cwd)
  const host = hostOf($, cwd, home)
  // The project's config, then the settings menu's switches over it (a reload brings new ones).
  const projectConfig = parseConfig(await host.read(`${cwd}/.conductor/config.json`))
  let config = applySwitches(projectConfig, options)
  // Connectors are named differently per install: each `auto` server is found by the tools only it has.
  const toolNames = (await $.tool.list()).map(t => t.name)
  config = resolveServers(config, toolNames)
  const ts = config.taskSource
  const unresolved = ts.kind !== 'local' && ts[ts.kind].server === 'auto'
  if (unresolved) {
    $.ui.toast(`conductor: no ${ts.kind} MCP server in this session; using the local task file`)
    config = { ...config, taskSource: { ...ts, kind: 'local' } }
  }
  const { conductor, router, board } = await build($, host, config, onBoard, toolNames)
  return { host, projectConfig, config, conductor, router, board, toolNames }
}

const asText = (value: unknown) => ({ result: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Each worker's switch (and which one turned it off) and whether it can run. */
function workerLines(c: Conductor, project: ConductorConfig, options: SwitchOptions): string {
  return c.workers.map(w => {
    const id: WorkerId = w.id
    const where = options[workerOption(id)] === false ? 'off in settings'
      : project.executors[id].enabled === false ? 'off in .conductor/config.json'
      : 'on'
    const via = ` via ${project.executors[id].provider}`
    const state = w.installed === undefined ? '' : w.installed ? ' · ready' : ` · ${w.reason ?? 'unavailable'}`
    return `  ${id.padEnd(12)} ${where}${where === 'on' ? via : ''}${state}`
  }).join('\n')
}

/** The surfaces that draw `Svg`; the terminal gets text bars. */
const SVG_SURFACES: readonly string[] = ['desktop', 'mobile', 'vscode']

/** Draws a task's graph in its pane (and saves it as .mmd beside the run's state). */
async function showGraph($: EngineInterface, c: Conductor, cwd: string, taskId: string): Promise<{ text: string; isPlaced: boolean; path: string }> {
  const g = await c.graph(taskId)
  const path = `${cwd}/.conductor/graphs/${taskId}.mmd`
  await $.fs.write(path, `${g.mermaid}\n`)
  await update($, graphView, () => ({ taskId, mermaid: g.mermaid, path: g.path }))
  const opened = await $.ui.open({ id: GRAPH_PANE, title: `Graph · ${taskId}` })
  return { text: `${g.path}\n\n\`\`\`mermaid\n${g.mermaid}\n\`\`\``, isPlaced: opened.isPlaced, path }
}

/** Publishes the run's state and opens the dashboard beside the chat. */
async function openDashboard($: EngineInterface, c: Conductor, runId: string): Promise<boolean> {
  const value = await c.summary(runId)
  const { tasks } = await c.status(runId)
  const rows = c.boardRows(tasks)
  await update($, summary, () => value)
  await update($, boardRows, () => rows)
  const opened = await $.ui.open({ id: PANE, title: `Conductor · ${runId}` })
  return opened.isPlaced
}

export const register: Register = (on, options) => {
  // Rebuilt on every session.start (a hot reload runs it again); module state does not outlive a reload.
  let conductor: Conductor | undefined
  let router: DecisionRouter | undefined
  let board: Board | undefined
  let host: Host | undefined
  let config: ConductorConfig | undefined
  let projectConfig: ConductorConfig | undefined
  let detected: Promise<unknown> = Promise.resolve()
  let heartbeat: { cancel(): void } | undefined
  let isTicking = false
  // Worktrees whose task has a process running: the maestro's edits there are refused.
  let busyWorktrees: string[] = []
  const trackBusy = (rows: ConductorBoardRow[]) => {
    busyWorktrees = rows.flatMap(r => (r.isBusy ? [...(r.worktree ? [r.worktree] : []), ...(r.busyWorktrees ?? [])] : []))
  }

  const need = (): Conductor => {
    if (conductor === undefined) throw new Error('the Conductor is not initialised yet')
    return conductor
  }

  const tickActive = async () => {
    if (isTicking || conductor === undefined) return
    isTicking = true
    try {
      await detected
      const run = await conductor.activeRun()
      if (run !== undefined && run.status !== 'planning') await conductor.tick(run.id)
    } finally {
      isTicking = false
    }
  }

  const resolveRun = async (runId?: string) => {
    const run = runId ? undefined : await need().activeRun()
    const id = runId ?? run?.id
    if (id === undefined) throw new Error('no active run: start one with /conduct plan <goal>')
    return id
  }

  const reconcileActive = async () => {
    const c = need()
    const run = await c.activeRun()
    if (run === undefined) return undefined
    const done = await c.reconcile(run.id)
    await tickActive()
    return done
  }

  const apply = (setup: SessionSetup): Conductor => {
    ;({ host, config, projectConfig, conductor, router, board } = setup)
    const c = setup.conductor
    // Detection probes CLIs (seconds); reconciliation waits for it, the session does not.
    detected = c.detectExecutors().catch(() => undefined)
    if (setup.config.enabled) void detected.then(() => reconcileActive()).catch(() => undefined)
    return c
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const c = apply(await setUp($, e.cwd, options, trackBusy))
    if (config === undefined) return started

    await $.command.register({
      name: 'conduct',
      description: 'Conductor: plan, run and watch a factory of parallel coding workers',
      argumentHint: SUBCOMMANDS,
      immediate: true,
    })
    await $.tool.register({
      name: 'conductor_plan',
      description: 'Record the plan of a Conductor run: the tasks workers will execute in parallel, each in its own git worktree. Call once after planning; the run starts at once.',
      inputSchema: {
        type: 'object',
        required: ['tasks'],
        properties: {
          runId: { type: 'string', description: 'The run being planned (from the planning prompt); omit to use the active run' },
          goal: { type: 'string', description: 'Goal of a new run, when there is no runId and no active run' },
          tasks: { type: 'array', items: TASK_SCHEMA },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'conductor_status',
      description: 'The Conductor board: every task of the run with its status, executor, tier and note.',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'conductor_approve',
      description: 'Approve a task in needs_review: its change is accepted and merged into the integration branch (or, before any work, it may run).',
      inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' }, note: { type: 'string' } } },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'conductor_reject',
      description: 'Reject a task in needs_review. With retry, it runs again (optionally on another executor) with the reason in its history.',
      inputSchema: {
        type: 'object',
        required: ['taskId', 'reason'],
        properties: {
          taskId: { type: 'string' },
          reason: { type: 'string' },
          retry: { type: 'boolean' },
          executor: { type: 'string', enum: WORKERS },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'conductor_dispatch',
      description: 'Force a task (failed, needs_review, classified or ready) to run next, optionally on a given executor.',
      inputSchema: {
        type: 'object',
        required: ['taskId'],
        properties: { taskId: { type: 'string' }, executor: { type: 'string', enum: WORKERS } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'ask_openrouter',
      description: 'Ask one question of any model on OpenRouter (summaries, fixtures, second opinions). Not for editing code. Secrets and CPF/CNPJ are redacted before sending.',
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
          model: { type: 'string', description: 'OpenRouter model id, e.g. "openai/gpt-5.4-mini"; default from config' },
          prompt: { type: 'string' },
          system: { type: 'string' },
          maxTokens: { type: 'number' },
        },
      },
    })

    heartbeat?.cancel()
    heartbeat = undefined
    if (config.enabled) {
      heartbeat = $.clock.every(config.heartbeatMs, () => {
        void tickActive().catch(err => $.ui.log(`conductor: heartbeat failed: ${errorText(err)}`, { to: 'debug' }))
      })
    }

    const run = config.enabled ? await c.activeRun() : undefined
    await update($, summary, () => null)
    await update($, boardRows, () => [])
    if (run !== undefined) {
      const current = await c.summary(run.id)
      await update($, summary, () => current)
    }
    return started
  })

  // After /clear the conversation forgot; the task source did not. (classic.SessionStart would
  // say so too, but the built-in cc-plugin-sec-default passes it on before a mod sees it.)
  // The end hook's budget is short, so the reconciliation runs a moment later.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && config?.enabled) {
      $.clock.after(1000, () => {
        void reconcileActive().catch(() => undefined)
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'conduct' }, async ($, e) => {
    const [sub = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const c = need()
    const switchTo = async (key: string, value: boolean): Promise<string | undefined> => {
      const res = await $.config.set({ key: `conductor.${key}`, value })
      return 'deny' in res && res.deny !== undefined ? `Could not change the setting: ${res.deny}` : undefined
    }
    try {
      switch (sub) {
        case 'on':
        case 'off': {
          const isOn = sub === 'on'
          const denied = await switchTo('enabled', isOn)
          if (denied) return { text: denied }
          if (isOn && projectConfig?.enabled === false) {
            return { text: 'On in settings, but this project switches the Conductor off in .conductor/config.json ("enabled": false).' }
          }
          return { text: isOn ? 'Conductor on.' : 'Conductor off: nothing new is planned or dispatched; workers already running finish and are read when it is back on.' }
        }
        case 'workers': {
          await detected
          const project = projectConfig ?? config
          if (project === undefined) return { text: 'The Conductor is not initialised yet.' }
          return { text: `Conductor: ${c.isEnabled ? 'on' : 'off'} · gateway ${project.gateway}\n${workerLines(c, project, options)}\n\nSwitch one with /conduct worker <id> on|off, or in /config.` }
        }
        case 'worker': {
          const [id, state] = rest
          if (id === undefined || !isWorker(id) || (state !== 'on' && state !== 'off')) {
            return { text: `Usage: /conduct worker <${WORKERS.join('|')}> on|off` }
          }
          const denied = await switchTo(workerOption(id), state === 'on')
          if (denied) return { text: denied }
          const projectOff = state === 'on' && projectConfig?.executors[id].enabled === false
          return { text: `Worker ${id} ${state}.${projectOff ? ' Note: this project switches it off in .conductor/config.json.' : ''}` }
        }
        case 'plan': {
          const goal = e.args.trim().slice('plan'.length).trim()
          if (goal === '') return { text: 'Usage: /conduct plan <goal>' }
          if (!c.isEnabled) return { text: OFF }
          const active = await c.activeRun()
          if (active !== undefined && active.status !== 'planning') {
            return { text: `Run ${active.id} is already ${active.status}. Use /conduct stop before opening another.` }
          }
          const runId = await c.createRun(goal)
          void $.prompt.submit({ text: planningPrompt(runId, goal) })
          return { text: `Run ${runId} created. Claude was asked for the plan; it calls conductor_plan when done.` }
        }
        case 'run': {
          if (!c.isEnabled) return { text: OFF }
          const runId = await resolveRun(rest[0])
          const { tasks } = await c.status(runId)
          if (tasks.length === 0) return { text: `Run ${runId} has no plan yet.` }
          await c.setRunStatus(runId, 'active')
          await detected
          const { requeued, killed } = await c.reconcile(runId)
          void tickActive()
          await openDashboard($, c, runId)
          const fixed = requeued + killed > 0 ? ` Reconciled: ${requeued} task(s) back in the queue, ${killed} orphan process(es) stopped.` : ''
          return { text: `Run ${runId} running (heartbeat every ${Math.round((config?.heartbeatMs ?? 0) / 1000)} s).${fixed}` }
        }
        case 'status': {
          const runId = await resolveRun(rest[0])
          const { text, tasks } = await c.status(runId)
          trackBusy(c.boardRows(tasks))
          const isPlaced = await openDashboard($, c, runId)
          const where = isPlaced ? '\n\n(The dashboard is open in the pane beside the chat.)' : ''
          return { text: `${text}${c.isEnabled ? '' : '\n\n(The Conductor is off: /conduct on to resume.)'}${where}` }
        }
        case 'graph': {
          const taskId = rest[0]
          if (taskId === undefined) return { text: 'Usage: /conduct graph <taskId>' }
          const shown = await showGraph($, c, host?.cwd ?? (await $.session.cwd()), taskId)
          const where = shown.isPlaced ? '(drawn in the pane beside the chat)' : `(saved to ${shown.path})`
          return { text: `${shown.text}\n${where}` }
        }
        case 'pause': {
          const runId = await resolveRun(rest[0])
          await c.setRunStatus(runId, 'paused')
          return { text: `Run ${runId} paused: nothing new is dispatched; what is running finishes.` }
        }
        case 'stop': {
          const runId = await resolveRun(rest[0])
          const killed = await c.stop(runId)
          return { text: `Run ${runId} stopped: ${killed} process(es) ended, open tasks cancelled.` }
        }
        case 'retry': {
          const [taskId, executor] = rest
          if (taskId === undefined) return { text: 'Usage: /conduct retry <taskId> [worker]' }
          if (executor !== undefined && !isWorker(executor)) return { text: `Unknown worker: ${executor}` }
          await c.retry(taskId, executor)
          void tickActive()
          return { text: `${taskId} is back in the queue${executor ? ` on ${executor}` : ''}.` }
        }
        case 'cost': {
          const today = await c.spentToday()
          const day = config?.budgets.dayUsd ?? 0
          const runId = await resolveRun(rest[0])
          await openDashboard($, c, runId)
          return { text: `${await c.costText(runId)}\ntoday (all runs): US$ ${today.toFixed(2)} of US$ ${day.toFixed(2)}` }
        }
        case 'jev': {
          if (host === undefined) return { text: 'The Conductor is not initialised yet.' }
          const log = new DecisionLog(host, `${host.cwd}/.conductor/jev`)
          const mode: DecisionMode = router?.activeMode ?? 'rules'
          const note = mode === 'rules' && config?.decision.mode !== 'rules' ? '\n(Jev is inactive: set OPENROUTER_API_KEY for shadow or enforce mode.)' : ''
          return { text: `${reportText(buildReport(await log.readAll()), mode)}${note}` }
        }
        case 'key': {
          // The key goes from a native dialog (hidden input) to the macOS Keychain; it never enters the conversation.
          const script = `${$.plugin.root}/scripts/openrouter-key.sh`
          const action = rest[0] === 'status' ? 'status' : rest[0] === 'remove' ? 'delete' : 'set'
          const res = await $.process.run(['/bin/sh', script, action], { timeoutMs: 5 * 60_000 })
          if (res.exitCode !== 0) return { text: `OpenRouter key: ${res.stderr.trim() || 'not saved'}` }
          if (action === 'status') {
            const fromEnv = Boolean(await $.env.get('OPENROUTER_API_KEY'))
            return { text: `OpenRouter key: ${fromEnv ? 'set in the environment (OPENROUTER_API_KEY)' : `${res.stdout.trim()} in the macOS Keychain`}.` }
          }
          // A new key changes which workers can run and whether Jev answers: rebuild with it.
          apply(await setUp($, await $.session.cwd(), options, trackBusy))
          return { text: action === 'set' ? 'OpenRouter key saved, encrypted, in the macOS Keychain. Jev and the OpenRouter workers use it from now on.' : 'OpenRouter key removed from the macOS Keychain.' }
        }
        case 'source':
        case 'uranus': {
          const ts = config?.taskSource
          if (ts === undefined) return { text: 'The Conductor is not initialised yet.' }
          if (board === undefined) {
            const servers = `uranus: ${ts.uranus.server} · jira: ${ts.jira.server} · linear: ${ts.linear.server}`
            return { text: `Task source: the local file (.conductor/tasks.json). Boards found in this session (auto = not found): ${servers}. Set "taskSource.kind" in .conductor/config.json to use one.` }
          }
          return { text: `Task source: ${board.name} (read-only check)\n${await board.check()}` }
        }
        case 'figma': {
          const url = rest[0]
          if (url === undefined) return { text: 'Usage: /conduct figma <figma.com/design/... link>' }
          const server = config?.figma.server
          if (host === undefined || server === undefined || server === '' || server === 'auto') return { text: 'No Figma MCP server in this session (looked for get_design_context).' }
          return { text: await new FigmaDesignSource(host, { ...(config as ConductorConfig).figma, server }).context([url]) }
        }
        case 'handoff': {
          // Cheap: one question over this conversation, served mostly from the prompt cache (doc §10.5).
          const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
          if (!reply.isAnswered) return { text: `Could not write the handoff (${reply.reason}).` }
          const path = `${host?.cwd ?? (await $.session.cwd())}/.conductor/handoff.md`
          await $.fs.write(path, reply.text)
          return { text: `${reply.text}\n\n(saved to ${path})` }
        }
        default:
          return { text: USAGE }
      }
    } catch (err) {
      return { text: `conductor: ${errorText(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__conductor__conductor_plan' }, async ($, e) => {
    const input = parsePlanInput(e)
    const c = need()
    let runId = input.runId ?? (await c.activeRun())?.id
    if (runId === undefined) {
      if (!input.goal) return { deny: 'No active run: pass runId, or goal to open a new run.' }
      runId = await c.createRun(input.goal)
    }
    const tasks = await c.plan(runId, input.tasks)
    void tickActive()
    // The dashboard opens with the run, so progress is in view without asking for it.
    await openDashboard($, c, runId)
    $.ui.toast(`conductor: plan with ${tasks.length} task(s) recorded, run ${runId} started`)
    return asText(`Plan recorded for run ${runId}: ${tasks.length} task(s) (${tasks.map(t => `${t.key}=${t.id}`).join(', ')}). Workers start on the next heartbeat; you will be woken when something needs review. Do not implement these tasks yourself.`)
  }).catch(($, e, next) => ({ deny: `conductor_plan failed: ${errorText(next.error)}` }))

  on('tool.call', { tool: 'mcp__conductor__conductor_status' }, async ($, e) => {
    const input = parseStatusInput(e)
    const { text } = await need().status(await resolveRun(input.runId))
    return asText(text)
  }).catch(($, e, next) => ({ deny: `conductor_status failed: ${errorText(next.error)}` }))

  on('tool.call', { tool: 'mcp__conductor__conductor_approve' }, async ($, e) => {
    const input = parseApproveInput(e)
    const status = await need().approve(input.taskId, input.note)
    void tickActive()
    return asText(`${input.taskId} → ${status}`)
  }).catch(($, e, next) => ({ deny: `conductor_approve failed: ${errorText(next.error)}` }))

  on('tool.call', { tool: 'mcp__conductor__conductor_reject' }, async ($, e) => {
    const input = parseRejectInput(e)
    const status = await need().reject(input.taskId, input.reason, input.retry, input.executor)
    void tickActive()
    return asText(`${input.taskId} → ${status}`)
  }).catch(($, e, next) => ({ deny: `conductor_reject failed: ${errorText(next.error)}` }))

  on('tool.call', { tool: 'mcp__conductor__conductor_dispatch' }, async ($, e) => {
    const input = parseDispatchInput(e)
    await need().retry(input.taskId, input.executor)
    void tickActive()
    return asText(`${input.taskId} → ready${input.executor ? ` on ${input.executor}` : ''}`)
  }).catch(($, e, next) => ({ deny: `conductor_dispatch failed: ${errorText(next.error)}` }))

  on('tool.call', { tool: 'mcp__conductor__ask_openrouter' }, async ($, e) => {
    const input = parseAskOpenRouterInput(e)
    if (config === undefined || host === undefined) return { deny: 'the Conductor is not initialised yet' }
    const res = await openrouterComplete(host, config.openrouter.baseUrl, {
      model: input.model ?? config.openrouter.defaultModel,
      prompt: redact(input.prompt),
      system: input.system === undefined ? undefined : redact(input.system),
      maxTokens: input.maxTokens,
    })
    if (!res.ok) return { deny: `OpenRouter: ${res.error}` }
    const cost = res.costUsd === undefined ? '' : ` · US$ ${res.costUsd.toFixed(4)}`
    return asText(`${res.text}\n\n[${res.model}${cost}]`)
  }).catch(($, e, next) => ({ deny: `ask_openrouter failed: ${errorText(next.error)}` }))

  // Guard (doc §9.2): the maestro does not edit a worktree while its worker runs there. Fails closed.
  const isBusy = (path: unknown) => typeof path === 'string' && busyWorktrees.some(w => path === w || path.startsWith(`${w}/`))
  const guard = (tool: string) => `${tool} refused by conductor: that worktree belongs to a running task. Wait for it, or /conduct stop.`
  on('tool.call', { tool: 'Edit' }, ($, e, next) => (isBusy(e.file_path) ? { deny: guard('Edit') } : next(e)))
    .catch(($, e, next) => (next.called ? next(e) : { deny: 'conductor: its worktree guard failed' }))
  on('tool.call', { tool: 'Write' }, ($, e, next) => (isBusy(e.file_path) ? { deny: guard('Write') } : next(e)))
    .catch(($, e, next) => (next.called ? next(e) : { deny: 'conductor: its worktree guard failed' }))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => (isBusy(e.notebook_path) ? { deny: guard('NotebookEdit') } : next(e)))
    .catch(($, e, next) => (next.called ? next(e) : { deny: 'conductor: its worktree guard failed' }))

  // LGPD (doc §11): CPF/CNPJ and secrets masked before the conversation stores them. Off by default.
  // The prompt as typed: rewritten before it is recorded (a slash command's or a hidden prompt's text takes no rewrite).
  on('prompt.submit', async ($, e, next) => {
    if (options.redact_transcript !== true || e.command !== undefined || e.isMeta === true) return next(e)
    const masked = redact(e.text)
    return masked === e.text ? next(e) : next({ ...e, text: masked })
  }).catch(($, e, next) => next(e))
  // Every other row (tool results, the model's text). Registered only when switched on: a plugin
  // seated above (cc-plugin-sec-default) may pass this event on past it, and says so in the transcript.
  if (options.redact_transcript === true) on('session.append', async ($, e, next) => {
    const content = e.message.content.map(block => {
      const b = block as { type: string; text?: unknown; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') return { ...block, text: redact(b.text) }
      if (b.type === 'tool_result' && typeof b.content === 'string') return { ...block, content: redact(b.content) }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        return { ...block, content: b.content.map((c: { type?: string; text?: unknown }) => (c.type === 'text' && typeof c.text === 'string' ? { ...c, text: redact(c.text) } : c)) }
      }
      return block
    })
    return next({ ...e, message: { ...e.message, content: content as typeof e.message.content } })
  }).catch(($, e, next) => next(e))

  // The band above the prompt: progress bar, counts, tokens and cost; a second row lists running tasks.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, summary)
    if (e.props.hasSurvey || s === null || s.status === 'completed' || s.status === 'stopped') return next(e)
    const rows = await read($, boardRows)
    return band($.ui.resolve(e), { summary: s, rows, columns: e.props.bodyColumns, maxRows: e.props.maxRows, nowMs: Date.now() })
  })

  // The dashboard pane: opened with a run, and by /conduct status, run and cost.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const act = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
        void tickActive()
      } catch (err) {
        $.ui.toast(`conductor: ${errorText(err)}`)
      }
    }
    return dashboard(els, {
      summary: await read($, summary),
      rows: await read($, boardRows),
      columns: Math.max(30, e.props.bodyColumns),
      nowMs: Date.now(),
      // Every table names every element (an absent one draws nothing), so the surface decides.
      svg: SVG_SURFACES.includes(e.surface) && 'Svg' in els ? els.Svg : undefined,
      actions: {
        approve: id => void act(() => need().approve(id)),
        reject: id => void act(() => need().reject(id, 'retry requested from the dashboard', true)),
        retry: id => void act(() => need().retry(id)),
        graph: id => void act(async () => showGraph($, need(), host?.cwd ?? (await $.session.cwd()), id)),
      },
    })
  })

  // The graph pane (/conduct graph <taskId>): the template, the path taken, and why each edge was taken.
  on('ui.render', { component: 'Pane', requestId: GRAPH_PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const g = await read($, graphView)
    if (g === null) {
      return (
        <Box>
          <Text dimColor>No graph yet. Run /conduct graph &lt;taskId&gt;.</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Markdown key="graph-mermaid" text={`\`\`\`mermaid\n${g.mermaid}\n\`\`\``} />
        <Text dimColor>{g.path}</Text>
      </Box>
    )
  })
}
