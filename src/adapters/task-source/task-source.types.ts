import type { Run, Task, TaskStatus } from '../../core/domain.types.ts'

export interface TaskComment {
  at: string
  body: string
}

/** Where tasks come from and go back to: the source of truth (doc §2). */
export interface TaskSource {
  id: string
  createRun(goal: string, meta?: Record<string, unknown>): Promise<{ runId: string }>
  getRun(runId: string): Promise<Run | undefined>
  /** Every run, newest first. */
  listRuns(): Promise<Run[]>
  updateRun(runId: string, patch: Partial<Omit<Run, 'id'>>): Promise<void>
  /** Inserts new tasks (no `id`, or an unknown one) and replaces known ones; returns them with real ids. */
  upsertTasks(runId: string, tasks: Task[]): Promise<Task[]>
  listTasks(runId: string, filter?: { status?: TaskStatus[] }): Promise<Task[]>
  transition(taskId: string, to: TaskStatus, note?: string): Promise<void>
  comment(taskId: string, body: string): Promise<void>
  publishUpdate(runId: string, body: string): Promise<void>
}

export interface FileShape {
  version: 1
  runs: Record<string, Run>
  tasks: Record<string, Task>
  comments: Record<string, TaskComment[]>
  updates: Record<string, TaskComment[]>
}
