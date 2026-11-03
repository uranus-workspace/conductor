import type { DecisionModel } from '../adapters/decision/decision.types.ts'
import { scopeCreep } from '../adapters/decision/rules.ts'
import type { Executor, ExecutorRequest } from '../adapters/executors/executor.types.ts'
import type { TaskSource } from '../adapters/task-source/task-source.types.ts'
import { checkWrites, isTerminal, mermaid, nodesOf, resolveEdge } from '../graph/engine.ts'
import type { Cursor, EdgeDecision, GraphTemplate, NodeId, NodeOutcome, NodeRun, Shard, TaskState } from '../graph/graph.types.ts'
import { templateOf } from '../graph/templates/index.ts'
import { researchPrompt, reviewPrompt, workerPrompt } from '../prompts/worker.ts'
import type { DesignSource, Notifier, WorkerStatus } from './conductor.types.ts'
import { modelFor } from './config.ts'
import type { ConductorConfig } from './config.types.ts'
import type { Attempt, BoardRow, ExecutorId, ExecutorResult, Job, PlanInput, Run, RunSummary, Task, TaskStatus } from './domain.types.ts'
import * as git from './git.ts'
import type { Host } from './host.types.ts'
import { killJob, pollJob, startJob, tail } from './jobs.ts'
import { escalate, pickAvailable } from './routing.ts'
import { findCycle, isBlocked, isReady } from './state-machine.ts'
import { iso } from './time.ts'

const OPEN: readonly TaskStatus[] = ['planned', 'classified', 'ready', 'dispatched', 'running', 'verifying', 'needs_review', 'approved', 'done']
const usd = (n: number) => `US$ ${n.toFixed(2)}`
const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0] ?? ''

/** Reviewers by preference for an author: another lab first (§5B, independent verification). */
const REVIEWERS: Readonly<Record<ExecutorId, readonly ExecutorId[]>> = {
  claude: ['codex', 'antigravity', 'cursor', 'opencode'],
  codex: ['claude', 'antigravity', 'cursor', 'opencode'],
  cursor: ['claude', 'codex', 'antigravity', 'opencode'],
  opencode: ['claude', 'codex', 'antigravity', 'cursor'],
  antigravity: ['claude', 'codex', 'cursor', 'opencode'],
  openrouter: ['claude', 'codex', 'antigravity', 'cursor', 'opencode'],
}

export class Conductor {
  private readonly host: Host
  private readonly source: TaskSource
  private readonly decision: DecisionModel
  private readonly executors: Map<ExecutorId, Executor>
  private readonly config: ConductorConfig
  private readonly notifier: Notifier
  private readonly design: DesignSource | undefined
  private available: ExecutorId[] = []
  private workerStatus: WorkerStatus[] = []
  private lock: Promise<unknown> = Promise.resolve()

  constructor(
    host: Host, source: TaskSource, decision: DecisionModel, executors: Executor[], config: ConductorConfig, notifier: Notifier,
    design?: DesignSource,
  ) {
    this.host = host
    this.source = source
    this.decision = decision
    this.executors = new Map(executors.map(e => [e.id, e]))
    this.config = config
    this.notifier = notifier
    this.design = design
  }

  /** Everything that reads and writes tasks runs one at a time: the heartbeat, tools, commands. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  /**
   * Checks which executors are switched on, installed and logged in (doc §8.6);
   * the rest leave routing and review. A switched-off worker is not even probed.
   */
  async detectExecutors(): Promise<ExecutorId[]> {
    const found: ExecutorId[] = []
    const workers: WorkerStatus[] = []
    for (const ex of this.executors.values()) {
      const enabled = ex.config.enabled
      const availability = enabled ? await ex.available(this.host) : undefined
      workers.push({ id: ex.id, enabled, installed: availability?.ok, reason: availability?.ok === false ? availability.reason : undefined })
      if (availability?.ok) found.push(ex.id)
    }
    this.available = found
    this.workerStatus = workers
    return found
  }

  /** Each worker adapter: its switch, and whether it was found (unknown while off). */
  get workers(): readonly WorkerStatus[] {
    return this.workerStatus
  }

  get isEnabled(): boolean {
    return this.config.enabled
  }

  get availableExecutors(): readonly ExecutorId[] {
    return this.available
  }

  private get worktreeRoot(): string {
    return git.worktreeRoot(this.host.cwd, this.host.home, this.config.worktreeRoot)
  }

  private get paths() {
    return (runId: string) => git.paths(this.host.cwd, runId, this.worktreeRoot)
  }

  // ---------- runs ----------

  async activeRun(): Promise<Run | undefined> {
    const runs = await this.source.listRuns()
    return runs.find(r => r.status === 'planning' || r.status === 'active' || r.status === 'paused')
  }

  async createRun(goal: string): Promise<string> {
    return this.exclusive(async () => {
      const { runId } = await this.source.createRun(goal)
      return runId
    })
  }

  /** Records the maestro's plan (the `plan` node): validates it, writes it, and starts the run. */
  async plan(runId: string, inputs: PlanInput[]): Promise<Task[]> {
    return this.exclusive(async () => {
      if (!this.config.enabled) throw new Error('the Conductor is switched off (/conduct on)')
      const run = await this.source.getRun(runId)
      if (run === undefined) throw new Error(`unknown run ${runId}`)
      if (inputs.length === 0) throw new Error('a plan needs at least one task')
      const keys = new Set<string>()
      for (const t of inputs) {
        if (!t.key || keys.has(t.key)) throw new Error(`task keys must be unique and non-empty (${t.key})`)
        if (!t.acceptance?.length) throw new Error(`task ${t.key} has no acceptance criteria`)
        keys.add(t.key)
      }
      const existing = await this.source.listTasks(runId)
      const byKey = new Map(existing.filter(t => t.key).map(t => [t.key as string, t.id]))
      const now = iso(await this.host.now())

      // First pass gets ids, second wires dependsOn from keys to ids.
      const drafts: Task[] = inputs.map(input => ({
        id: '',
        runId,
        key: input.key,
        title: input.title,
        description: input.description,
        acceptance: input.acceptance,
        files: input.files,
        dependsOn: [],
        status: 'planned',
        attempts: [],
        labels: input.labels,
        client: input.client,
        designRefs: input.designRefs,
        cursor: 'route',
        cursorSince: now,
        nodeRuns: [{ node: 'plan', attempt: 0, startedAt: now, finishedAt: now, status: 'ok', writes: ['tasks', 'acceptance', 'dependsOn'], decision: { from: 'plan', to: 'route', reason: 'planned by the maestro' } }],
      }))
      const saved = await this.source.upsertTasks(runId, drafts)
      saved.forEach(t => byKey.set(t.key as string, t.id))
      const wired = saved.map((t, i) => ({
        ...t,
        dependsOn: (inputs[i]?.dependsOn ?? []).map(k => {
          const id = byKey.get(k)
          if (id === undefined) throw new Error(`task ${t.key} depends on unknown key ${k}`)
          return id
        }),
      }))
      const cycle = findCycle([...existing, ...wired])
      if (cycle !== undefined) throw new Error(`dependency cycle through ${cycle}`)
      const tasks = await this.source.upsertTasks(runId, wired)

      await git.excludeConductorDir(this.host, this.host.cwd)
      const { branch, baseRef } = await git.ensureIntegration(this.host, this.host.cwd, runId, this.worktreeRoot)
      await this.source.updateRun(runId, { status: 'active', integrationBranch: branch, baseRef: run.baseRef ?? baseRef })
      return tasks
    })
  }

  async setRunStatus(runId: string, status: Run['status']): Promise<void> {
    await this.exclusive(async () => {
      await this.source.updateRun(runId, { status })
      await this.publishSummary(runId)
    })
  }

  /** Cancels everything still open and kills its processes. */
  async stop(runId: string): Promise<number> {
    return this.exclusive(async () => {
      const tasks = await this.source.listTasks(runId)
      let killed = 0
      for (const t of tasks) {
        for (const job of this.jobsOf(t)) {
          await killJob(this.host, job)
          killed++
        }
        if (this.jobsOf(t).length) await this.save(this.withoutJobs(t))
        if (OPEN.includes(t.status) || t.status === 'failed') {
          await this.source.transition(t.id, 'cancelled', 'run stopped')
          await this.decision.label?.({ ...t, status: 'cancelled' }).catch(() => undefined)
        }
        for (const a of t.attempts) {
          await git.removeWorktree(this.host, this.host.cwd, a.worktree).catch(() => undefined)
          for (const s of a.shards ?? []) await git.removeWorktree(this.host, this.host.cwd, s.worktree).catch(() => undefined)
        }
      }
      await this.source.updateRun(runId, { status: 'stopped' })
      await this.publishSummary(runId)
      return killed
    })
  }

  // ---------- the maestro's decisions ----------

  private async taskOf(taskId: string): Promise<Task> {
    for (const run of await this.source.listRuns()) {
      const hit = (await this.source.listTasks(run.id)).find(t => t.id === taskId)
      if (hit) return hit
    }
    throw new Error(`unknown task ${taskId}`)
  }

  /** The maestro (or the user) approves a task in needs_review: the human gate passes, or the task moves on. */
  async approve(taskId: string, note?: string): Promise<TaskStatus> {
    return this.exclusive(async () => {
      const t = await this.taskOf(taskId)
      if (t.status !== 'needs_review') throw new Error(`${taskId} is ${t.status}, not needs_review`)
      const events: string[] = []
      const at = iso(await this.host.now())
      if (t.cursor === 'human') {
        const approved = await this.save({ ...t, approval: { by: 'maestro', at }, reviewedByMaestro: true })
        await this.completeNode(approved, 'human', { status: 'ok', reason: note ?? 'approved', writes: ['approval'] }, events)
      } else if (t.attempts.at(-1)?.changedFiles === undefined) {
        // Reviewed before any work (a human decision): clear the flag and let it run.
        const cls = t.classification ? { ...t.classification, needsHuman: 0 } : undefined
        const cleared = await this.save({ ...t, classification: cls, reviewedByMaestro: true })
        await this.enterNode(cleared, this.template(cleared).entry, note ?? 'approved by the maestro', events)
      } else {
        const approved = await this.save({ ...t, reviewedByMaestro: true })
        await this.enterNode(approved, this.template(approved).merges ? 'merge' : 'END', note ?? 'approved by the maestro', events)
      }
      return (await this.taskOf(taskId)).status
    })
  }

  async reject(taskId: string, reason: string, retry: boolean, executor?: ExecutorId): Promise<TaskStatus> {
    return this.exclusive(async () => {
      const t = await this.taskOf(taskId)
      if (t.status !== 'needs_review') throw new Error(`${taskId} is ${t.status}, not needs_review`)
      const saved = await this.save({ ...t, noRetry: !retry, forcedExecutor: executor ?? t.forcedExecutor, reviewedByMaestro: true })
      const events: string[] = []
      if (retry) await this.enterNode(saved, this.retryNode(saved), `retry requested by the maestro: ${reason}`, events)
      else await this.enterNode(saved, 'failed', `rejected: ${reason}`, events)
      return (await this.taskOf(taskId)).status
    })
  }

  /** Forces a new attempt, optionally on another executor; ignores the retry limit. */
  async retry(taskId: string, executor?: ExecutorId): Promise<void> {
    await this.exclusive(async () => {
      const t = await this.taskOf(taskId)
      if (executor !== undefined && !this.executors.has(executor)) throw new Error(`unknown executor ${executor}`)
      if (t.status !== 'failed' && t.status !== 'needs_review' && t.status !== 'classified' && t.status !== 'ready') {
        throw new Error(`${taskId} is ${t.status}; only failed, needs_review, classified or ready tasks can be retried`)
      }
      const saved = await this.save({ ...t, forcedExecutor: executor ?? t.forcedExecutor, noRetry: false })
      if (t.status !== 'ready') await this.enterNode(saved, this.retryNode(saved), `retry${executor ? ` on ${executor}` : ''}`, [])
    })
  }

  /** Where a retry goes: implement once there is work, the template's entry before that. */
  private retryNode(t: Task): NodeId {
    const tpl = this.template(t)
    return t.attempts.length > 0 && nodesOf(tpl).includes('implement') ? 'implement' : tpl.entry
  }

  // ---------- the heartbeat ----------

  /** One heartbeat (doc §10.2): advance nodes whose process ended, route, merge, dispatch, wake. */
  async tick(runId: string): Promise<void> {
    await this.exclusive(async () => {
      // Switched off: nothing moves; detached workers keep running and are read when it is back on.
      if (!this.config.enabled) return
      const run = await this.source.getRun(runId)
      if (run === undefined || (run.status !== 'active' && run.status !== 'paused')) return
      const events: string[] = []

      for (const t of await this.source.listTasks(runId)) {
        if (this.jobsOf(t).length === 0) continue
        if (t.status === 'cancelled') {
          // Cancelled from outside (the Uranus OS board): its processes go too.
          for (const job of this.jobsOf(t)) await killJob(this.host, job)
          await this.save(this.withoutJobs(t))
          continue
        }
        await this.advance(t, events).catch(err => this.failNode(t, `internal: ${String(err)}`, events))
      }
      if (run.status === 'active') {
        await this.route(runId, events)
        await this.mergeReady(run, events)
        if (await this.enforceBudgets(run, events)) await this.dispatchReady(run, events)
      }
      await this.settle(runId, events)
      await this.publishSummary(runId)
    })
  }

  private template(t: Task): GraphTemplate {
    return templateOf(t.template)
  }

  private jobsOf(t: Task): Job[] {
    const shards = t.attempts.at(-1)?.shards ?? []
    return [...(t.job ? [t.job] : []), ...shards.flatMap(s => (s.job ? [s.job] : []))]
  }

  private withoutJobs(t: Task): Task {
    const last = t.attempts.at(-1)
    if (last?.shards === undefined) return { ...t, job: undefined }
    const shards = last.shards.map(s => ({ ...s, job: undefined }))
    return { ...t, job: undefined, attempts: [...t.attempts.slice(0, -1), { ...last, shards }] }
  }

  private async save(t: Task): Promise<Task> {
    const [saved] = await this.source.upsertTasks(t.runId, [t])
    return saved ?? t
  }

  /** The derived status, written to the task source only when it changes. */
  private async setStatus(t: Task, to: TaskStatus, note?: string): Promise<Task> {
    if (t.status === to) return this.save({ ...t, note })
    await this.source.transition(t.id, to, note)
    return { ...(await this.taskOf(t.id)), status: to, note }
  }

  private async stateOf(t: Task, node: NodeId, outcome: NodeOutcome): Promise<TaskState> {
    const limits = { ...this.template(t).limits, maxRetries: Math.min(this.template(t).limits.maxRetries, this.config.maxRetries) }
    const started = t.nodeRuns?.[0]?.startedAt ?? t.attempts[0]?.startedAt
    const minutes = started ? ((await this.host.now()) - Date.parse(started)) / 60_000 : 0
    return {
      task: t,
      node,
      outcome,
      // Retries are counted on the edges taken back, so a node that fails before any attempt cannot loop.
      retries: (t.nodeRuns ?? []).filter(r => r.decision?.rule === 'retry').length,
      costUsd: this.costOf([t]),
      minutes,
      limits,
      verifyThreshold: this.config.verifyThreshold,
    }
  }

  /**
   * A node finished: its writes are checked against its ownership, the run is
   * checkpointed, the edge out of it is resolved and recorded, and the next node entered.
   */
  private async completeNode(t: Task, node: NodeId, outcome: NodeOutcome, events: string[]): Promise<void> {
    checkWrites(node, outcome.writes)
    const now = iso(await this.host.now())
    const target = resolveEdge(this.template(t), node, await this.stateOf(t, node, outcome))
    const decision: EdgeDecision = { from: node, to: target.to, reason: target.reason, rule: target.rule }
    const run: NodeRun = {
      node, attempt: t.attempts.length, startedAt: t.cursorSince ?? now, finishedAt: now,
      status: outcome.status, writes: outcome.writes, costUsd: outcome.costUsd, decision,
    }
    const saved = await this.save({ ...this.withoutJobs(t), nodeRuns: [...(t.nodeRuns ?? []), run] })
    await this.enterNode(saved, target.to, target.reason, events)
  }

  /** A node that cannot go on fails through its own edge (retry while the limits allow). */
  private async failNode(t: Task, reason: string, events: string[]): Promise<void> {
    const fresh = await this.taskOf(t.id)
    for (const job of this.jobsOf(fresh)) await killJob(this.host, job).catch(() => undefined)
    const node: NodeId = fresh.cursor !== undefined && !isTerminal(fresh.cursor) ? fresh.cursor : 'implement'
    if (fresh.status === 'failed' || fresh.status === 'cancelled' || fresh.status === 'merged') return
    const now = iso(await this.host.now())
    const attempts = fresh.attempts.map((a, i, all) => (i === all.length - 1 ? { ...a, finishedAt: a.finishedAt ?? now, error: reason } : a))
    const saved = await this.save({ ...this.withoutJobs(fresh), attempts })
    await this.completeNode(saved, node === 'route' || node === 'plan' ? 'implement' : node, { status: 'fail', reason, writes: [] }, events)
  }

  /** Enters a node (or a terminal): sets the cursor, derives the status, and starts what the node runs. */
  private async enterNode(t: Task, cursor: Cursor, reason: string, events: string[]): Promise<void> {
    const now = iso(await this.host.now())
    let task = await this.save({ ...t, cursor, cursorSince: now })
    switch (cursor) {
      case 'END': {
        const merged = await this.setStatus(task, 'merged', reason)
        await this.commentPath(merged)
        await this.decision.label?.(merged).catch(() => undefined)
        events.push(`✓ ${t.id} ${this.template(t).merges ? 'merged' : 'finished'}: ${t.title}`)
        this.notifier.toast(`conductor: ${t.id} ${this.template(t).merges ? 'merged' : 'finished'}`)
        return
      }
      case 'failed': {
        const failed = await this.setStatus(task, 'failed', reason)
        await this.commentPath(failed)
        await this.decision.label?.(failed).catch(() => undefined)
        events.push(`✗ ${t.id} failed: ${firstLine(reason)}`)
        this.notifier.toast(`conductor: ${t.id} failed (${firstLine(reason).slice(0, 60)})`)
        return
      }
      case 'needs_review':
        await this.setStatus(task, 'needs_review', reason)
        events.push(`? ${t.id} needs review: ${firstLine(reason)}`)
        return
      case 'human':
        await this.setStatus(task, 'needs_review', `human approval required (${this.template(t).id} template): ${reason}`)
        events.push(`? ${t.id} waits at the human gate`)
        return
      case 'research':
      case 'implement':
        await this.setStatus(task, 'ready', reason)
        return
      case 'merge':
        await this.setStatus(task, 'done', reason)
        return
      case 'check':
        task = await this.setStatus(task, 'verifying', reason)
        return this.startCheck(task, events)
      case 'security':
        task = await this.setStatus(task, 'verifying', reason)
        return this.startSecurity(task, events)
      case 'review':
        task = await this.setStatus(task, 'verifying', reason)
        return this.startReview(task, events)
      case 'judge':
        task = await this.setStatus(task, 'verifying', reason)
        return this.runJudge(task, events)
      case 'report':
        task = await this.setStatus(task, 'verifying', reason)
        return this.writeReport(task, events)
      case 'plan':
      case 'route':
        await this.setStatus(task, cursor === 'route' ? 'classified' : 'planned', reason)
        return
    }
  }

  /**
   * The path a finished task took, as a Mermaid comment on it (Uranus OS renders Markdown).
   * Its whiteboards are created empty and their drawing cannot be set over MCP, so a comment it is.
   */
  private async commentPath(t: Task): Promise<void> {
    const runs = t.nodeRuns ?? []
    const tpl = this.template(t)
    const body = `**${tpl.id}** template, ${runs.length} node run(s), ${usd(this.costOf([t]))}\n\n\`\`\`mermaid\n${mermaid(tpl, runs, t.cursor)}\n\`\`\``
    await this.source.comment(t.id, body.slice(0, 5000)).catch(() => undefined)
  }

  /** The `route` node: classification and template, then the template's entry once dependencies merged. */
  private async route(runId: string, events: string[]): Promise<void> {
    const tasks = await this.source.listTasks(runId)
    const open = tasks.filter(t => OPEN.includes(t.status))
    for (const t of tasks.filter(x => x.status === 'planned')) {
      const others = open.filter(o => o.id !== t.id).flatMap(o => o.files ?? [])
      const classification = await this.decision.classify(t, { openTaskFiles: others, available: this.available })
      // Without deterministic checks, `solo` would merge unverified work: it gets a review and a judge.
      const picked = classification.template ?? 'solo'
      const template = picked === 'solo' && this.config.checks.length === 0 ? 'feature' : picked
      const tpl = templateOf(template)
      const now = iso(await this.host.now())
      const routeRun: NodeRun = {
        node: 'route', attempt: 0, startedAt: t.cursorSince ?? now, finishedAt: now, status: 'ok', writes: ['classification', 'template'],
        decision: { from: 'route', to: tpl.entry, reason: `${template} template, ${classification.executor}/${classification.tier} (${classification.source})`, rule: picked !== template ? 'no checks: solo → feature' : 'route' },
      }
      checkWrites('route', routeRun.writes)
      const saved = await this.save({ ...t, classification, template, templateVersion: tpl.version, cursor: 'route', nodeRuns: [...(t.nodeRuns ?? []), routeRun] })
      await this.setStatus(saved, 'classified', `${template} · ${classification.executor}/${classification.tier} (${classification.source})`)
    }
    // Waiting at route → the template's entry once dependencies merged; a human question goes to the maestro first.
    const all = await this.source.listTasks(runId)
    for (const t of all.filter(x => x.status === 'classified')) {
      if ((t.classification?.needsHuman ?? 0) >= 0.5) {
        await this.enterNode(t, 'needs_review', 'needs a human decision before it can run', events)
      } else if (isReady(t, all)) {
        await this.enterNode(t, this.template(t).entry, 'dependencies merged', events)
      }
    }
  }

  /** Busy workers, counted per executor and in total (fan-out shards each count). */
  private busy(tasks: readonly Task[]): Map<ExecutorId | 'total', number> {
    const count = new Map<ExecutorId | 'total', number>()
    const bump = (k: ExecutorId | 'total') => count.set(k, (count.get(k) ?? 0) + 1)
    for (const t of tasks) {
      for (const job of this.jobsOf(t)) {
        bump('total')
        if (job.executor) bump(job.executor)
      }
    }
    return count
  }

  /** Starts the research and implement nodes waiting for a worker, within concurrency. */
  private async dispatchReady(run: Run, events: string[]): Promise<void> {
    const tasks = await this.source.listTasks(run.id)
    const busy = this.busy(tasks)
    const room = (id: ExecutorId) =>
      (busy.get('total') ?? 0) < this.config.concurrency.total &&
      (busy.get(id) ?? 0) < (this.config.concurrency[id] ?? 1)
    const take = (id: ExecutorId, n: number) => {
      busy.set(id, (busy.get(id) ?? 0) + n)
      busy.set('total', (busy.get('total') ?? 0) + n)
    }

    for (const t of tasks.filter(x => x.status === 'ready')) {
      const node = t.cursor === 'research' ? 'research' : 'implement'
      const wanted = node === 'research' ? this.config.graph.researchExecutor : t.forcedExecutor ?? t.classification?.executor ?? 'claude'
      const id = pickAvailable(wanted, this.available)
      if (id === undefined) {
        events.push(`⚠ no executor available for ${t.id}`)
        return
      }
      if (!room(id)) continue
      try {
        if (node === 'research') {
          await this.dispatchResearch(run, t, id)
          take(id, 1)
        } else {
          take(id, await this.dispatchImplement(run, t, id))
        }
      } catch (err) {
        await this.failNode(t, `dispatch: ${String(err)}`, events)
      }
    }
  }

  private async openrouterKeyFor(executor: Executor): Promise<string | undefined> {
    return executor.config.provider === 'openrouter' ? this.host.openrouterKey() : undefined
  }

  /** Design references (Figma) become notes before the first implement attempt. */
  private async withDesign(t: Task): Promise<Task> {
    if (!t.designRefs?.length || this.design === undefined || (t.notes ?? '').includes('## Design references')) return t
    const context = await this.design.context(t.designRefs).catch(err => `(design context unavailable: ${String(err)})`)
    return this.save({ ...t, notes: `${t.notes ? `${t.notes}\n\n` : ''}## Design references\n${context}` })
  }

  /** The `research` node: a cheap worker reads, in a throwaway worktree, and writes notes. */
  private async dispatchResearch(run: Run, t: Task, id: ExecutorId): Promise<void> {
    const executor = this.executors.get(id)
    if (executor === undefined) throw new Error(`executor ${id} has no adapter`)
    const p = this.paths(run.id)
    const n = t.attempts.length + 1
    const worktree = `${p.worktree(t.id, n)}-research`
    const logDir = `${p.logs(t.id, n)}/research`
    const baseRef = await git.headOf(this.host, p.integration)
    await git.addWorktree(this.host, this.host.cwd, worktree, `${git.taskBranch(run.id, t.id, n)}-research`, baseRef)
    const task = await this.withDesign(t)
    const purpose = this.template(task).id === 'bugfix' ? 'reproduce' : this.template(task).id === 'spike' ? 'investigate' : 'context'
    const prompt = researchPrompt(task, purpose)
    await this.host.write(`${logDir}/prompt.md`, prompt)
    const req: ExecutorRequest = {
      task, worktree, logDir, prompt, model: modelFor(executor.config, 'cheap'), mode: 'review',
      timeoutMs: this.config.timeouts.reviewMs, openrouterKey: await this.openrouterKeyFor(executor),
    }
    await executor.prepare?.(this.host, req)
    const cmd = executor.command(req)
    const job = await startJob(this.host, {
      kind: 'research', dir: logDir, cwd: worktree, argv: cmd.argv, env: cmd.env, unset: cmd.unset, timeoutMs: this.config.timeouts.reviewMs,
    })
    const saved = await this.save({ ...task, job: { ...job, executor: id } })
    await this.setStatus(saved, 'running', `research on ${id}, pid ${job.pid}`)
  }

  /** The `implement` node: one worker (or one per module, on a fan-out template). Returns the workers it took. */
  private async dispatchImplement(run: Run, t: Task, id: ExecutorId): Promise<number> {
    const executor = this.executors.get(id)
    if (executor === undefined) throw new Error(`executor ${id} has no adapter`)
    const n = t.attempts.length + 1
    const tier = escalate(t.classification?.tier ?? 'standard', n - 1)
    const p = this.paths(run.id)
    const worktree = p.worktree(t.id, n)
    const branch = git.taskBranch(run.id, t.id, n)
    const logDir = p.logs(t.id, n)

    let task = await this.setStatus(await this.withDesign(t), 'dispatched', `${id}/${tier} attempt ${n}`)
    // The previous attempt's worktrees go; their branches stay for inspection.
    const previous = t.attempts.at(-1)
    if (previous) {
      await git.removeWorktree(this.host, this.host.cwd, previous.worktree)
      for (const s of previous.shards ?? []) await git.removeWorktree(this.host, this.host.cwd, s.worktree)
    }
    const baseRef = await git.headOf(this.host, p.integration)
    await git.addWorktree(this.host, this.host.cwd, worktree, branch, baseRef)
    const model = modelFor(executor.config, tier)
    const spent = this.costOf([t])
    const groups = this.template(task).fanOut?.by(task) ?? []
    const now = iso(await this.host.now())

    const launch = async (scope: Task, dir: string, cwd: string) => {
      const prompt = workerPrompt(scope, this.config.checks)
      await this.host.write(`${dir}/prompt.md`, prompt)
      const req: ExecutorRequest = {
        task: scope, worktree: cwd, logDir: dir, prompt, model, mode: 'implement',
        timeoutMs: this.config.timeouts.implementMs, checks: this.config.checks,
        budgetUsd: Math.max(0.5, this.config.budgets.taskUsd - spent), openrouterKey: await this.openrouterKeyFor(executor),
      }
      await executor.prepare?.(this.host, req)
      const cmd = executor.command(req)
      const job = await startJob(this.host, {
        kind: 'implement', dir, cwd, argv: cmd.argv, env: cmd.env, unset: cmd.unset,
        timeoutMs: this.config.timeouts.implementMs, pre: this.config.setup.join(' && ') || undefined,
      })
      return { ...job, executor: id }
    }

    let attempt: Attempt = { executor: id, tier, model, worktree, branch, baseRef, logDir, startedAt: now }
    if (groups.length > 1) {
      // Fan-out: one worker per module group, each in its own worktree from the same base.
      const shards: Shard[] = []
      for (const [i, files] of groups.entries()) {
        const sw = `${worktree}-s${i + 1}`
        const sb = `${branch}-s${i + 1}`
        const sd = `${logDir}/implement-s${i + 1}`
        await git.addWorktree(this.host, this.host.cwd, sw, sb, baseRef)
        const scope: Task = { ...task, files, description: `${task.description}\n\n(Part ${i + 1} of ${groups.length}: only the files listed in scope.)` }
        shards.push({ files, worktree: sw, branch: sb, logDir: sd, job: await launch(scope, sd, sw) })
      }
      attempt = { ...attempt, shards }
      task = await this.save({ ...task, attempts: [...t.attempts, attempt] })
      await this.setStatus(task, 'running', `${id}/${tier} attempt ${n}, fan-out over ${shards.length} module(s)`)
      return shards.length
    }
    const job = await launch(task, `${logDir}/implement`, worktree)
    task = await this.save({ ...task, attempts: [...t.attempts, { ...attempt, startedAt: job.startedAt }], job })
    await this.setStatus(task, 'running', `${id}/${tier} attempt ${n}, pid ${job.pid}`)
    return 1
  }

  /** A task's process(es) ended, timed out or vanished: the node they belong to finishes. */
  private async advance(t: Task, events: string[]): Promise<void> {
    const shards = t.attempts.at(-1)?.shards
    if (shards !== undefined && t.job === undefined) return this.advanceShards(t, shards, events)
    const job = t.job
    if (job === undefined) return
    const state = await pollJob(this.host, job)
    if (state.state === 'running') return
    if (state.state === 'timeout') await killJob(this.host, job)
    const exitCode = state.state === 'exited' ? state.exitCode : -1
    const why = state.state === 'timeout' ? `timeout after ${Math.round(job.timeoutMs / 60_000)} min` : state.state === 'lost' ? 'lost: the process vanished without an exit code' : undefined

    switch (job.kind) {
      case 'research': return this.finishResearch(t, job, exitCode, why, events)
      case 'implement': return this.finishImplement(t, job, exitCode, why, events)
      case 'check': return this.finishCheck(t, job, exitCode, why, events)
      case 'security': return this.finishSecurity(t, job, exitCode, why, events)
      case 'review': return this.finishReview(t, job, exitCode, why, events)
    }
  }

  private async finishResearch(t: Task, job: Job, exitCode: number, why: string | undefined, events: string[]): Promise<void> {
    const executor = job.executor ? this.executors.get(job.executor) : undefined
    const result = why || executor === undefined ? undefined : await executor.collect(this.host, job.dir, exitCode)
    const n = t.attempts.length + 1
    await git.removeWorktree(this.host, this.host.cwd, `${this.paths(t.runId).worktree(t.id, n)}-research`)
    if (result?.ok && result.summary.trim() !== '') {
      const saved = await this.save({ ...t, notes: `${result.summary.trim()}${t.notes ? `\n\n${t.notes}` : ''}` })
      return this.completeNode(saved, 'research', { status: 'ok', writes: ['notes'], costUsd: result.costUsd }, events)
    }
    return this.completeNode(t, 'research', { status: 'skip', reason: why ?? result?.error ?? 'no notes', writes: [], costUsd: result?.costUsd }, events)
  }

  private async finishImplement(t: Task, job: Job, exitCode: number, why: string | undefined, events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1)
    if (attempt === undefined) return this.failNode(t, 'job without attempt', events)
    if (why) return this.failNode(t, why, events)
    const executor = this.executors.get(attempt.executor)
    const result: ExecutorResult = executor
      ? await executor.collect(this.host, job.dir, exitCode)
      : { ok: false, exitCode, summary: '', error: `no adapter for ${attempt.executor}` }
    const now = iso(await this.host.now())
    let next: Attempt = {
      ...attempt, finishedAt: now, exitCode, summary: result.summary.slice(0, 4000),
      costUsd: result.costUsd, costEstimated: result.costEstimated, tokens: result.tokens,
    }
    if (!result.ok) {
      await this.save({ ...t, job: undefined, attempts: [...t.attempts.slice(0, -1), next] })
      return this.failNode(await this.taskOf(t.id), result.error ?? `exit ${exitCode}`, events)
    }
    if (executor?.materialize) {
      try {
        await executor.materialize(this.host, { task: t, worktree: attempt.worktree }, result)
      } catch (err) {
        await this.save({ ...t, job: undefined, attempts: [...t.attempts.slice(0, -1), next] })
        return this.failNode(await this.taskOf(t.id), `materialize: ${String(err)}`, events)
      }
    }
    const { changedFiles, diffStat } = await git.commitAll(this.host, attempt.worktree, `conductor: ${t.id} ${t.title}`, attempt.baseRef)
    next = { ...next, changedFiles, diffStat }
    const saved = await this.save({ ...t, job: undefined, attempts: [...t.attempts.slice(0, -1), next] })
    if (changedFiles.length === 0) return this.failNode(saved, 'the worker made no changes', events)
    return this.completeNode(saved, 'implement', { status: 'ok', reason: diffStat, writes: ['attempt.result', 'attempt.diff'], costUsd: result.costUsd }, events)
  }

  /** Fan-in: once every shard ended, their branches merge into the attempt's worktree. */
  private async advanceShards(t: Task, shards: Shard[], events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1) as Attempt
    const executor = this.executors.get(attempt.executor)
    let changed = false
    const next: Shard[] = []
    for (const s of shards) {
      if (s.done || s.job === undefined) {
        next.push(s)
        continue
      }
      const state = await pollJob(this.host, s.job)
      if (state.state === 'running') {
        next.push(s)
        continue
      }
      changed = true
      if (state.state === 'timeout') await killJob(this.host, s.job)
      const exitCode = state.state === 'exited' ? state.exitCode : -1
      const result = state.state === 'exited' && executor ? await executor.collect(this.host, s.job.dir, exitCode) : undefined
      if (result?.ok) await git.commitAll(this.host, s.worktree, `conductor: ${t.id} ${t.title} (part)`, attempt.baseRef)
      next.push({
        ...s, job: undefined, done: true, ok: result?.ok === true, summary: result?.summary.slice(0, 1000), costUsd: result?.costUsd,
        error: result?.ok ? undefined : result?.error ?? state.state,
      })
    }
    const costUsd = next.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
    let saved = changed ? await this.save({ ...t, attempts: [...t.attempts.slice(0, -1), { ...attempt, shards: next, costUsd }] }) : t
    if (!next.every(s => s.done)) return
    const failed = next.filter(s => !s.ok)
    if (failed.length) return this.failNode(saved, `fan-out: ${failed.length} of ${next.length} part(s) failed: ${firstLine(failed[0]?.error)}`, events)
    for (const s of next) {
      const outcome = await git.mergeInto(this.host, attempt.worktree, s.branch, `conductor: ${t.id} fan-in ${s.branch}`)
      if (!outcome.ok) return this.failNode(saved, `fan-in conflict between parts: ${outcome.conflict}`, events)
      await git.removeWorktree(this.host, this.host.cwd, s.worktree)
    }
    const { changedFiles, diffStat } = await git.commitAll(this.host, attempt.worktree, `conductor: ${t.id} ${t.title}`, attempt.baseRef)
    const now = iso(await this.host.now())
    saved = await this.save({
      ...saved,
      attempts: [...saved.attempts.slice(0, -1), { ...attempt, shards: next, costUsd, changedFiles, diffStat, finishedAt: now, summary: next.map(s => s.summary ?? '').join('\n---\n').slice(0, 4000) }],
    })
    if (changedFiles.length === 0) return this.failNode(saved, 'the workers made no changes', events)
    return this.completeNode(saved, 'implement', { status: 'ok', reason: `fan-in of ${next.length} parts: ${diffStat}`, writes: ['attempt.result', 'attempt.diff'], costUsd }, events)
  }

  /** The `check` node: deterministic checks in the worktree. */
  private async startCheck(t: Task, events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1)
    if (this.config.checks.length === 0 || attempt === undefined) {
      return this.completeNode(t, 'check', { status: 'skip', writes: [] }, events)
    }
    const job = await startJob(this.host, {
      kind: 'check', dir: `${attempt.logDir}/check`, cwd: attempt.worktree,
      argv: ['/bin/sh', '-c', this.config.checks.join(' && ')],
      timeoutMs: this.config.timeouts.checkMs, pre: this.config.setup.join(' && ') || undefined,
    })
    await this.save({ ...t, job })
  }

  private async finishCheck(t: Task, job: Job, exitCode: number, why: string | undefined, events: string[]): Promise<void> {
    if (why) return this.completeNode(t, 'check', { status: 'fail', reason: `checks: ${why}`, writes: ['attempt.checks'] }, events)
    if (exitCode !== 0) {
      const out = await tail(this.host, `${job.dir}/out.log`)
      const pre = await tail(this.host, `${job.dir}/pre.log`, 600)
      return this.completeNode(t, 'check', { status: 'fail', reason: `checks failed (exit ${exitCode})\n${pre}${out}`, writes: ['attempt.checks'] }, events)
    }
    return this.completeNode(t, 'check', { status: 'ok', writes: ['attempt.checks'] }, events)
  }

  /** The `security` node: the configured scanner (Umbriel, semgrep, ...) in the worktree; none configured skips it. */
  private async startSecurity(t: Task, events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1)
    if (this.config.graph.securityCommand.trim() === '' || attempt === undefined) {
      return this.completeNode(t, 'security', { status: 'skip', writes: [] }, events)
    }
    const job = await startJob(this.host, {
      kind: 'security', dir: `${attempt.logDir}/security`, cwd: attempt.worktree,
      argv: ['/bin/sh', '-c', this.config.graph.securityCommand], timeoutMs: this.config.timeouts.checkMs,
    })
    await this.save({ ...t, job })
  }

  private async finishSecurity(t: Task, job: Job, exitCode: number, why: string | undefined, events: string[]): Promise<void> {
    const findings = why ?? (await tail(this.host, `${job.dir}/out.log`, 3000))
    const attempt = t.attempts.at(-1) as Attempt
    const saved = await this.save({ ...t, attempts: [...t.attempts.slice(0, -1), { ...attempt, findings }] })
    const failed = why !== undefined || exitCode !== 0
    return this.completeNode(saved, 'security', { status: failed ? 'fail' : 'ok', reason: failed ? findings : undefined, writes: ['attempt.findings'] }, events)
  }

  /** A reviewer that is not the author's worker, from another lab when possible (§5B, a hard rule). */
  pickReviewer(author: ExecutorId): ExecutorId | undefined {
    const usable = (id: ExecutorId) => id !== author && this.available.includes(id) && this.executors.get(id)?.verdict !== undefined
    const preferred = this.config.review.executor
    if (preferred !== 'auto' && usable(preferred)) return preferred
    return REVIEWERS[author].find(usable)
  }

  /** The `review` node: read-only, sees the task, the criteria, the diff and the checks, never the author's reasoning. */
  private async startReview(t: Task, events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1)
    const reviewerId = attempt && this.config.review.enabled ? this.pickReviewer(attempt.executor) : undefined
    const reviewer = reviewerId ? this.executors.get(reviewerId) : undefined
    if (attempt === undefined || reviewerId === undefined || reviewer === undefined) {
      return this.completeNode(t, 'review', { status: 'skip', writes: [] }, events)
    }
    const checksOut = this.config.checks.length ? await tail(this.host, `${attempt.logDir}/check/out.log`) : ''
    const prompt = reviewPrompt(t, attempt.baseRef, checksOut)
    await this.host.write(`${attempt.logDir}/review/prompt.md`, prompt)
    const req: ExecutorRequest = {
      task: t, worktree: attempt.worktree, logDir: `${attempt.logDir}/review`, prompt, mode: 'review',
      model: modelFor(reviewer.config, 'standard'), timeoutMs: this.config.timeouts.reviewMs,
      schemaPath: `${this.host.pluginRoot}/schemas/review.json`, openrouterKey: await this.openrouterKeyFor(reviewer),
    }
    // Every node that starts a worker prepares it first (Claude via OpenRouter needs its context file).
    await reviewer.prepare?.(this.host, req)
    const cmd = reviewer.command(req)
    const job = await startJob(this.host, {
      kind: 'review', dir: `${attempt.logDir}/review`, cwd: attempt.worktree,
      argv: cmd.argv, env: cmd.env, unset: cmd.unset, timeoutMs: this.config.timeouts.reviewMs,
    })
    await this.save({ ...t, job: { ...job, executor: reviewerId }, attempts: [...t.attempts.slice(0, -1), { ...attempt, reviewer: reviewerId }] })
  }

  private async finishReview(t: Task, job: Job, exitCode: number, why: string | undefined, events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1) as Attempt
    const reviewer = job.executor ? this.executors.get(job.executor) : undefined
    const verdict = why || reviewer?.verdict === undefined ? undefined : await reviewer.verdict(this.host, job.dir, exitCode)
    const cost = reviewer && !why ? (await reviewer.collect(this.host, job.dir, exitCode)).costUsd : undefined
    const saved = await this.save({
      ...t,
      attempts: [...t.attempts.slice(0, -1), { ...attempt, verdict: verdict?.verdict ?? 'review', costUsd: cost === undefined ? attempt.costUsd : (attempt.costUsd ?? 0) + cost }],
    })
    // A reviewer that produced nothing approved nothing: it counts as unsure, and the next node weighs it.
    const review = verdict?.verdict ?? 'review'
    const reason = verdict ? `${verdict.summary}${verdict.issues.length ? `\n${verdict.issues.map(i => `- ${i}`).join('\n')}` : ''}` : `reviewer gave no verdict${why ? ` (${why})` : ''}`
    return this.completeNode(saved, 'review', { status: review === 'fail' ? 'fail' : 'ok', review, reason, writes: ['attempt.review'], costUsd: cost }, events)
  }

  /** The `judge` node: Jev or the rules on the evidence, scope creep measured in code. */
  private async runJudge(t: Task, events: string[]): Promise<void> {
    const attempt = t.attempts.at(-1)
    const lastCheck = [...(t.nodeRuns ?? [])].reverse().find(r => r.node === 'check')
    const checksPassed = lastCheck === undefined || lastCheck.status === 'skip' ? null : lastCheck.status === 'ok'
    const checksOutput = checksPassed === null ? undefined : await tail(this.host, `${attempt?.logDir}/check/out.log`, 2000)
    const evidence = {
      checksPassed, checksOutput, reviewVerdict: attempt?.reviewer ? attempt.verdict : undefined,
      changedFiles: attempt?.changedFiles ?? [], diffStat: attempt?.diffStat,
    }
    const v = await this.decision.isVerified(t, evidence)
    // A model may report more scope creep than the code measures, never less.
    const creep = Math.max(scopeCreep(t, evidence.changedFiles), v.scopeCreep ?? 0)
    const tooWide = creep > this.config.scopeCreepThreshold
    return this.completeNode(t, 'judge', {
      status: tooWide ? 'fail' : 'ok',
      verdict: v.verified,
      reason: tooWide ? `scope creep: ${Math.round(creep * 100)}% of changed files outside the declared scope` : undefined,
      writes: ['attempt.verdict'],
    }, events)
  }

  /** The `report` node of a spike: its notes become a file in the project, nothing is merged. */
  private async writeReport(t: Task, events: string[]): Promise<void> {
    const path = `${this.host.cwd}/.conductor/reports/${t.id}.md`
    await this.host.write(path, `# ${t.title}\n\n${t.description}\n\n## Findings\n\n${t.notes ?? '(the research produced no notes)'}\n`)
    const saved = await this.save({ ...t, report: path })
    return this.completeNode(saved, 'report', { status: t.notes ? 'ok' : 'skip', reason: path, writes: ['report'] }, events)
  }

  /** The `merge` node: one integration at a time; a conflict goes to the maestro. */
  private async mergeReady(run: Run, events: string[]): Promise<void> {
    const integration = this.paths(run.id).integration
    for (const t of await this.source.listTasks(run.id, { status: ['done'] })) {
      const last = t.attempts.at(-1)
      if (last === undefined) continue
      const outcome = await git.mergeInto(this.host, integration, last.branch, `conductor: ${t.id} ${t.title}`)
      if (outcome.ok) {
        await git.removeWorktree(this.host, this.host.cwd, last.worktree)
        const commit = await git.headOf(this.host, integration)
        const reason = `merged ${last.branch} into ${run.integrationBranch} at ${commit.slice(0, 8)}${last.diffStat ? ` (${last.diffStat.trim()})` : ''}`
        await this.completeNode({ ...t, cursor: 'merge' }, 'merge', { status: 'ok', reason, writes: ['mergedAt', 'commit'] }, events)
      } else {
        await this.enterNode(t, 'needs_review', `merge conflict with ${run.integrationBranch}: ${outcome.conflict}`, events)
      }
    }
  }

  /** Run and day budgets (doc §10.6); false when nothing new may be dispatched. */
  private async enforceBudgets(run: Run, events: string[]): Promise<boolean> {
    const cost = this.costOf(await this.source.listTasks(run.id))
    if (cost >= this.config.budgets.runUsd) {
      await this.source.updateRun(run.id, { status: 'paused' })
      events.push(`⏸ run paused: cost ${usd(cost)} reached the run budget of ${usd(this.config.budgets.runUsd)}`)
      this.notifier.toast(`conductor: run budget reached (${usd(cost)}), paused`)
      return false
    }
    const today = await this.spentToday()
    if (today >= this.config.budgets.dayUsd) {
      events.push(`⏸ day budget reached: ${usd(today)} of ${usd(this.config.budgets.dayUsd)} today; nothing new is dispatched until tomorrow`)
      return false
    }
    return true
  }

  /** Spend of attempts started today (local date), across every run. */
  async spentToday(): Promise<number> {
    const day = (ms: number) => {
      const d = new Date(ms)
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    }
    const today = day(await this.host.now())
    let sum = 0
    for (const run of await this.source.listRuns()) {
      for (const t of await this.source.listTasks(run.id)) {
        for (const a of t.attempts) if (day(Date.parse(a.startedAt)) === today) sum += a.costUsd ?? 0
      }
    }
    return sum
  }

  /**
   * After /clear, a restart or a crash (doc §10.3): resume from each task's saved cursor,
   * never from the transcript. A job node left without its process is entered again;
   * a process no task owns any more is killed.
   */
  async reconcile(runId: string): Promise<{ requeued: number; killed: number }> {
    return this.exclusive(async () => {
      const tasks = await this.source.listTasks(runId)
      const events: string[] = []
      let requeued = 0
      for (const t of tasks) {
        if (this.jobsOf(t).length > 0) continue
        if (t.status === 'dispatched' || (t.status === 'running' && t.attempts.at(-1)?.shards === undefined)) {
          await this.enterNode(t, t.cursor === 'research' ? 'research' : 'implement', 'reconciled: dispatched without a process', events)
          requeued++
        } else if (t.status === 'verifying' && t.cursor !== undefined && ['check', 'security', 'review', 'judge', 'report'].includes(t.cursor)) {
          await this.enterNode(t, t.cursor, 'reconciled: resumed at its cursor', events)
          requeued++
        }
      }
      const owned = new Set(tasks.flatMap(t => this.jobsOf(t).map(j => j.dir)))
      const logs = `${this.host.cwd}/.conductor/logs/${runId}`
      let killed = 0
      for (const taskDir of await this.host.list(logs)) {
        for (const attemptDir of await this.host.list(`${logs}/${taskDir}`)) {
          for (const phase of await this.host.list(`${logs}/${taskDir}/${attemptDir}`)) {
            const dir = `${logs}/${taskDir}/${attemptDir}/${phase}`
            if (owned.has(dir) || (await this.host.exists(`${dir}/exit`))) continue
            const pid = Number.parseInt(((await this.host.read(`${dir}/pid`)) ?? '').trim(), 10)
            if (!Number.isFinite(pid)) continue
            const job: Job = { kind: 'implement', dir, pid, startedAt: iso(0), timeoutMs: 0 }
            if ((await pollJob(this.host, job)).state !== 'lost') {
              await killJob(this.host, job)
              killed++
            }
          }
        }
      }
      return { requeued, killed }
    })
  }

  /** A task that ended in `failed` stays there: its retries were taken on the graph's edges. */
  private isFinalFailure(t: Task): boolean {
    return t.status === 'failed'
  }

  /** Wakes the maestro once per new state that needs judgment (doc §10.4). */
  private async settle(runId: string, events: string[]): Promise<void> {
    const run = await this.source.getRun(runId)
    if (run === undefined) return
    const tasks = await this.source.listTasks(runId)
    const review = tasks.filter(t => t.status === 'needs_review')
    const finalFailed = tasks.filter(t => t.status === 'failed' && this.isFinalFailure(t))
    const blocked = tasks.filter(t => t.status === 'classified' && isBlocked(t, tasks, x => this.isFinalFailure(x)))
    const moving = tasks.some(t => this.jobsOf(t).length > 0 || ['planned', 'ready', 'dispatched', 'running', 'verifying', 'approved', 'done'].includes(t.status) ||
      (t.status === 'classified' && !blocked.includes(t)))
    const allMerged = tasks.length > 0 && tasks.every(t => t.status === 'merged' || t.status === 'cancelled')

    const merged = tasks.filter(t => t.status === 'merged').length
    if (merged > 0 && (merged - (run.lastUpdateAt ?? 0) >= 5 || allMerged) && merged !== run.lastUpdateAt) {
      await this.source.publishUpdate(runId, this.statusText(run, tasks))
      await this.source.updateRun(runId, { lastUpdateAt: merged })
    }

    let reason: string | undefined
    if (allMerged) {
      await this.source.updateRun(runId, { status: 'completed' })
      reason = `Run ${runId} completed: all ${tasks.length} tasks merged into ${run.integrationBranch}. Review the integration branch and decide whether to merge it (never push without the user's confirmation).`
      this.notifier.toast(`conductor: run ${runId} completed`)
    } else if (review.length > 0) {
      reason = `${review.length} task(s) need your review.`
    } else if (!moving && (finalFailed.length > 0 || blocked.length > 0)) {
      reason = `Run ${runId} is stuck: ${finalFailed.length} task(s) failed for good, ${blocked.length} blocked by them.`
    } else if (run.status === 'paused' && events.some(e => e.startsWith('⏸'))) {
      reason = 'The run was paused by its budget.'
    }
    if (reason === undefined) return

    const signature = tasks.map(t => `${t.id}:${t.status}`).sort().join(',') + `|${run.status}`
    if (signature === run.lastWake) return
    await this.source.updateRun(runId, { lastWake: signature })
    const details = [...review.map(t => `- ${t.id} "${t.title}" (${t.template ?? 'solo'} at ${t.cursor ?? '?'}): ${t.note ?? ''}\n  branch ${t.attempts.at(-1)?.branch ?? '(none)'}, logs ${t.attempts.at(-1)?.logDir ?? '(none)'}`),
      ...finalFailed.map(t => `- ${t.id} failed: ${firstLine(t.note)}`)]
    await this.notifier.wake(`[conductor] ${reason}
${events.length ? `\nThis heartbeat:\n${events.map(e => `- ${e}`).join('\n')}\n` : ''}${details.length ? `\n${details.join('\n')}\n` : ''}
Use conductor_status for the board, then conductor_approve / conductor_reject (with retry and executor) or /conduct retry. /conduct graph <taskId> shows the path a task took. Read diffs with git in the task's worktree; full logs stay on disk, read only what you need.`)
  }

  // ---------- reading ----------

  costOf(tasks: readonly Task[]): number {
    return tasks.reduce((sum, t) => sum + t.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0), 0)
  }

  async summary(runId: string): Promise<RunSummary | null> {
    const run = await this.source.getRun(runId)
    if (run === undefined) return null
    const tasks = await this.source.listTasks(runId)
    return {
      runId,
      goal: run.goal,
      status: run.status,
      total: tasks.length,
      merged: tasks.filter(t => t.status === 'merged').length,
      running: tasks.filter(t => this.jobsOf(t).length > 0).length,
      review: tasks.filter(t => t.status === 'needs_review').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      costUsd: this.costOf(tasks),
    }
  }

  private async publishSummary(runId: string): Promise<void> {
    await this.notifier.summary(await this.summary(runId))
    await this.notifier.board(this.boardRows(await this.source.listTasks(runId)))
  }

  private who(t: Task): string {
    const last = t.attempts.at(-1)
    const cls = t.classification
    const worker = last ? `${last.executor}/${last.tier}` : cls ? `${cls.executor}/${cls.tier}` : '-'
    return t.template ? `${worker} · ${t.template}@${t.cursor ?? '?'}` : worker
  }

  boardRows(tasks: readonly Task[]): BoardRow[] {
    return tasks.map(t => {
      const last = t.attempts.at(-1)
      const shardTrees = (last?.shards ?? []).filter(s => s.job).map(s => s.worktree)
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        who: this.who(t),
        note: firstLine(t.note).slice(0, 160),
        worktree: last?.worktree,
        isBusy: this.jobsOf(t).length > 0,
        busyWorktrees: shardTrees.length ? shardTrees : undefined,
      }
    })
  }

  async status(runId: string): Promise<{ run: Run; tasks: Task[]; text: string }> {
    const run = await this.source.getRun(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    const tasks = await this.source.listTasks(runId)
    return { run, tasks, text: this.statusText(run, tasks) }
  }

  statusText(run: Run, tasks: readonly Task[]): string {
    const lines = tasks.map(t => {
      const deps = t.dependsOn.length ? ` ← ${t.dependsOn.join(',')}` : ''
      const note = t.note ? ` — ${firstLine(t.note).slice(0, 120)}` : ''
      return `${t.id.padEnd(14)} ${t.status.padEnd(12)} ${this.who(t).padEnd(30)} ${t.title}${deps}${note}`
    })
    return `run ${run.id} [${run.status}] ${run.goal}
integration: ${run.integrationBranch ?? '(not yet)'} · cost ${usd(this.costOf(tasks))} · workers on: ${this.available.join(', ') || 'none'}
${lines.join('\n') || '(no tasks yet)'}`
  }

  /** A task's template and the path it took, as Mermaid, with the edges' reasons (§5B observability). */
  async graph(taskId: string): Promise<{ task: Task; mermaid: string; path: string }> {
    const t = await this.taskOf(taskId)
    const tpl = this.template(t)
    const runs = t.nodeRuns ?? []
    const path = runs.map(r => `${r.node} (${r.status}${r.costUsd ? `, ${usd(r.costUsd)}` : ''}) → ${r.decision ? `${r.decision.to}: ${r.decision.reason}` : '…'}`).join('\n')
    return { task: t, mermaid: mermaid(tpl, runs, t.cursor), path: `${t.id} · ${tpl.id} v${t.templateVersion ?? tpl.version} · at ${t.cursor ?? '?'}\n${path}` }
  }

  async costText(runId: string): Promise<string> {
    const { run, tasks } = await this.status(runId)
    const byExecutor = new Map<string, { usd: number; attempts: number; estimated: boolean; tokens: number }>()
    const byClient = new Map<string, number>()
    const byNode = new Map<string, number>()
    for (const t of tasks) {
      for (const a of t.attempts) {
        const row = byExecutor.get(a.executor) ?? { usd: 0, attempts: 0, estimated: false, tokens: 0 }
        row.usd += a.costUsd ?? 0
        row.attempts++
        row.estimated ||= a.costUsd === undefined || a.costEstimated === true
        row.tokens += (a.tokens?.input ?? 0) + (a.tokens?.output ?? 0)
        byExecutor.set(a.executor, row)
        const client = t.client ?? '(no client)'
        byClient.set(client, (byClient.get(client) ?? 0) + (a.costUsd ?? 0))
      }
      for (const r of t.nodeRuns ?? []) if (r.costUsd) byNode.set(r.node, (byNode.get(r.node) ?? 0) + r.costUsd)
    }
    const ex = [...byExecutor].map(([id, r]) => `  ${id.padEnd(10)} ${usd(r.usd).padStart(12)}  ${r.attempts} attempt(s), ${r.tokens} tokens${r.estimated ? ' (some costs unknown)' : ''}`)
    const cl = [...byClient].map(([c, v]) => `  ${c.padEnd(16)} ${usd(v)}`)
    const nd = [...byNode].map(([n, v]) => `  ${n.padEnd(10)} ${usd(v)}`)
    return `run ${run.id} cost ${usd(this.costOf(tasks))}\nby executor:\n${ex.join('\n') || '  (none)'}\nby node:\n${nd.join('\n') || '  (none)'}\nby client:\n${cl.join('\n') || '  (none)'}`
  }
}
