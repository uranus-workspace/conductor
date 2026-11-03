import type { Host } from '../../core/host.types.ts'
import { assertTransition } from '../../core/state-machine.ts'
import { iso } from '../../core/time.ts'
import type { Run, Task, TaskStatus } from '../../core/domain.types.ts'
import type { FileShape, TaskSource } from './task-source.types.ts'
import { isJsonObject, objectAt, tryParse } from '../../core/json.ts'

const empty = (): FileShape => ({ version: 1, runs: {}, tasks: {}, comments: {}, updates: {} })

/**
 * The task file is the Conductor's own: checked to its top-level shape, so a foreign or
 * truncated file is refused instead of read as an empty board.
 */
export function parseTaskFile(path: string, text: string): FileShape {
  const o = tryParse(text)
  const sections = ['runs', 'tasks', 'comments', 'updates'] as const
  if (!isJsonObject(o) || !sections.every(k => o[k] === undefined || isJsonObject(o[k]))) {
    throw new Error(`${path} is not a Conductor task file`)
  }
  const base = empty()
  return {
    version: 1,
    runs: (objectAt(o, 'runs') ?? base.runs) as FileShape['runs'],
    tasks: (objectAt(o, 'tasks') ?? base.tasks) as FileShape['tasks'],
    comments: (objectAt(o, 'comments') ?? base.comments) as FileShape['comments'],
    updates: (objectAt(o, 'updates') ?? base.updates) as FileShape['updates'],
  }
}

/**
 * Dev/test source: one JSON file, `.conductor/tasks.json` in the project.
 * Every write is a full read-modify-write, so the file is always the truth.
 */
export class LocalFileTaskSource implements TaskSource {
  readonly id = 'local-file'
  private readonly host: Host
  private readonly path: string

  constructor(host: Host, path: string) {
    this.host = host
    this.path = path
  }

  private async load(): Promise<FileShape> {
    const text = await this.host.read(this.path)
    if (text === undefined || text.trim() === '') return empty()
    return parseTaskFile(this.path, text)
  }

  private async save(data: FileShape): Promise<void> {
    await this.host.write(this.path, `${JSON.stringify(data, null, 2)}\n`)
  }

  private async mutate<T>(fn: (data: FileShape) => T | Promise<T>): Promise<T> {
    const data = await this.load()
    const out = await fn(data)
    await this.save(data)
    return out
  }

  async createRun(goal: string, meta?: Record<string, unknown>): Promise<{ runId: string }> {
    const now = await this.host.now()
    return this.mutate(data => {
      let runId = `r${now.toString(36)}`
      while (data.runs[runId] !== undefined) runId += 'x'
      data.runs[runId] = { id: runId, goal, createdAt: iso(now), status: 'planning', meta }
      return { runId }
    })
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return (await this.load()).runs[runId]
  }

  async listRuns(): Promise<Run[]> {
    const data = await this.load()
    return Object.values(data.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async updateRun(runId: string, patch: Partial<Omit<Run, 'id'>>): Promise<void> {
    await this.mutate(data => {
      const run = data.runs[runId]
      if (run === undefined) throw new Error(`unknown run ${runId}`)
      data.runs[runId] = { ...run, ...patch, id: runId }
    })
  }

  async upsertTasks(runId: string, tasks: Task[]): Promise<Task[]> {
    return this.mutate(data => {
      if (data.runs[runId] === undefined) throw new Error(`unknown run ${runId}`)
      let n = Object.values(data.tasks).filter(t => t.runId === runId).length
      return tasks.map(task => {
        const known = task.id !== '' && data.tasks[task.id] !== undefined
        const id = known ? task.id : `${runId}-${++n}`
        const saved: Task = { ...task, id, runId }
        data.tasks[id] = saved
        return saved
      })
    })
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return (await this.load()).tasks[taskId]
  }

  async listTasks(runId: string, filter?: { status?: TaskStatus[] }): Promise<Task[]> {
    const data = await this.load()
    return Object.values(data.tasks).filter(
      t => t.runId === runId && (filter?.status === undefined || filter.status.includes(t.status)),
    )
  }

  async transition(taskId: string, to: TaskStatus, note?: string): Promise<void> {
    const now = await this.host.now()
    await this.mutate(data => {
      const task = data.tasks[taskId]
      if (task === undefined) throw new Error(`unknown task ${taskId}`)
      assertTransition(task, to)
      data.tasks[taskId] = { ...task, status: to, note }
      const line = `${task.status} → ${to}${note ? `: ${note}` : ''}`
      ;(data.comments[taskId] ??= []).push({ at: iso(now), body: line })
    })
  }

  async comment(taskId: string, body: string): Promise<void> {
    const now = await this.host.now()
    await this.mutate(data => {
      ;(data.comments[taskId] ??= []).push({ at: iso(now), body })
    })
  }

  async publishUpdate(runId: string, body: string): Promise<void> {
    const now = await this.host.now()
    await this.mutate(data => {
      ;(data.updates[runId] ??= []).push({ at: iso(now), body })
    })
  }
}
