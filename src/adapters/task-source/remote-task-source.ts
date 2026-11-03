import type { Run, Task, TaskStatus } from '../../core/domain.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { JsonObject } from '../../core/json.types.ts'
import { redact } from '../../core/redact.ts'
import type { Board } from './board.types.ts'
import type { LocalFileTaskSource } from './local-file.ts'
import type { TaskSource } from './task-source.types.ts'

/** The fine-grained state and the routing travel as labels (at most 10, 80 characters each). */
export function labelsOf(task: Task): string[] {
  const c = task.classification
  const last = task.attempts.at(-1)
  const out = ['conductor', `conductor:${task.status}`]
  const executor = last?.executor ?? c?.executor
  if (executor) out.push(`executor:${executor}`)
  const tier = last?.tier ?? c?.tier
  if (tier) out.push(`tier:${tier}`)
  if (c) out.push(`risk:${c.risk}`)
  if (task.template) out.push(`template:${task.template}`)
  return out
}

export function descriptionOf(task: Task, runId: string): string {
  const parts = [task.description, '', '## Acceptance criteria', ...task.acceptance.map(a => `- ${a}`)]
  if (task.files?.length) parts.push('', '## Files', ...task.files.map(f => `- \`${f}\``))
  if (task.designRefs?.length) parts.push('', '## Design', ...task.designRefs.map(r => `- ${r}`))
  parts.push('', `_Conductor · run ${runId} · ${task.id}_`)
  return redact(parts.join('\n')).slice(0, 20000)
}

/** Statuses whose note becomes a comment on the board: the ones a person acts on. */
const COMMENTED: readonly TaskStatus[] = ['needs_review', 'failed', 'done', 'merged']

/**
 * A board (Uranus OS, Jira, Linear) as the task source (doc §13), over the session's
 * MCP connections. Run = the board's container (epic, project), task = an item in
 * it, dependsOn = "blocks", transitions = the board's state plus `conductor:<status>`
 * labels, notes = comments, progress = updates. What only this machine needs
 * (processes, worktrees, attempts) stays in the local file beside it; every write
 * goes to the board first, so a transition the board refuses is not made (doc §5).
 */
export class RemoteTaskSource implements TaskSource {
  readonly id: string
  private readonly host: Host
  private readonly local: LocalFileTaskSource
  private readonly board: Board
  private readonly pull: boolean
  private lastPull = 0

  constructor(host: Host, local: LocalFileTaskSource, board: Board, pullCancellations: boolean) {
    this.id = `remote:${board.name}`
    this.host = host
    this.local = local
    this.board = board
    this.pull = pullCancellations
  }

  async createRun(goal: string, meta?: JsonObject): Promise<{ runId: string }> {
    const key = await this.board.createRun(goal)
    const { runId } = await this.local.createRun(goal, meta)
    await this.local.updateRun(runId, { remoteKey: key })
    return { runId }
  }

  getRun(runId: string): Promise<Run | undefined> {
    return this.local.getRun(runId)
  }

  listRuns(): Promise<Run[]> {
    return this.local.listRuns()
  }

  async updateRun(runId: string, patch: Partial<Omit<Run, 'id'>>): Promise<void> {
    const run = await this.local.getRun(runId)
    const outcome = patch.status === 'completed' || patch.status === 'stopped' ? patch.status : undefined
    if (run?.remoteKey && outcome && run.status !== patch.status) await this.board.finishRun(run.remoteKey, outcome)
    await this.local.updateRun(runId, patch)
  }

  async upsertTasks(runId: string, tasks: Task[]): Promise<Task[]> {
    const run = await this.local.getRun(runId)
    if (run === undefined) throw new Error(`unknown run ${runId}`)
    // What the board already has comes from the stored record: callers pass copies read earlier.
    const before = new Map((await this.local.listTasks(runId)).map(t => [t.id, t]))
    // Local first only for the id; nothing is "done" before the board has it.
    const saved = await this.local.upsertTasks(runId, tasks.map(t => {
      const known = before.get(t.id)
      return known ? { ...t, remoteKey: known.remoteKey ?? t.remoteKey, remoteSync: known.remoteSync ?? t.remoteSync } : t
    }))
    const byId = new Map([...before.values(), ...saved].map(t => [t.id, t]))
    const out: Task[] = []
    for (const task of saved) {
      let t = task
      const sync = { ...(t.remoteSync ?? {}) }
      if (!t.remoteKey) {
        const labels = labelsOf(t)
        t = { ...t, remoteKey: await this.board.createTask(t, run.remoteKey, descriptionOf(t, runId), labels) }
        sync.labels = labels.join(',')
        sync.status = this.board.stateFor(t.status)
      }
      const labels = labelsOf(t)
      if (labels.join(',') !== sync.labels && t.remoteKey) {
        await this.board.move(t.remoteKey, { labels, status: t.status })
        sync.labels = labels.join(',')
      }
      const links = new Set(sync.links ?? [])
      for (const depId of t.dependsOn) {
        const depKey = byId.get(depId)?.remoteKey ?? out.find(o => o.id === depId)?.remoteKey
        if (depKey === undefined || links.has(depId) || t.remoteKey === undefined) continue
        await this.board.relate(depKey, t.remoteKey)
        links.add(depId)
      }
      sync.links = [...links]
      out.push({ ...t, remoteSync: sync })
    }
    return this.local.upsertTasks(runId, out)
  }

  async listTasks(runId: string, filter?: { status?: TaskStatus[] }): Promise<Task[]> {
    if (this.pull) await this.pullCancellations(runId)
    return this.local.listTasks(runId, filter)
  }

  /** A task cancelled on the board is cancelled here too (at most every 30 s). */
  private async pullCancellations(runId: string): Promise<void> {
    const now = await this.host.now()
    if (now - this.lastPull < 30_000) return
    this.lastPull = now
    const run = await this.local.getRun(runId)
    if (!run?.remoteKey) return
    let cancelled: Set<string>
    try {
      cancelled = await this.board.cancelledKeys(run.remoteKey)
    } catch {
      return // a read that fails changes nothing
    }
    for (const t of await this.local.listTasks(runId)) {
      if (t.remoteKey && cancelled.has(t.remoteKey) && t.status !== 'cancelled' && t.status !== 'merged') {
        await this.local.transition(t.id, 'cancelled', `cancelled on the ${this.board.name} board`)
      }
    }
  }

  async transition(taskId: string, to: TaskStatus, note?: string): Promise<void> {
    const task = await this.local.getTask(taskId)
    if (task?.remoteKey) {
      const state = this.board.stateFor(to)
      const labels = labelsOf({ ...task, status: to })
      const stateChanged = state !== undefined && state !== task.remoteSync?.status
      const labelsChanged = labels.join(',') !== task.remoteSync?.labels
      if (stateChanged || labelsChanged) {
        await this.board.move(task.remoteKey, { state: stateChanged ? state : undefined, labels: labelsChanged ? labels : undefined, note, status: to })
      }
      if (note && COMMENTED.includes(to)) await this.board.comment(task.remoteKey, redact(`**${to}** — ${note}`).slice(0, 5000))
      await this.local.transition(taskId, to, note)
      const moved = await this.local.getTask(taskId)
      const status = stateChanged ? state : task.remoteSync?.status
      if (moved) await this.local.upsertTasks(task.runId, [{ ...moved, remoteSync: { ...task.remoteSync, status, labels: labels.join(',') } }])
      return
    }
    await this.local.transition(taskId, to, note)
  }

  async comment(taskId: string, body: string): Promise<void> {
    const task = await this.local.getTask(taskId)
    if (task?.remoteKey) await this.board.comment(task.remoteKey, redact(body).slice(0, 5000))
    await this.local.comment(taskId, body)
  }

  async publishUpdate(runId: string, body: string): Promise<void> {
    const run = await this.local.getRun(runId)
    await this.board.publishUpdate(run?.remoteKey, redact(body).slice(0, 20000))
    await this.local.publishUpdate(runId, body)
  }
}
