import type { Task, TaskStatus } from './domain.types.ts'

// The statuses a task may move between (doc §5A). Since §5B the status is derived from the
// task's place in its graph template; these edges are the ones that derivation produces.
// `cancelled` is reachable from every non-terminal status.
const EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['planned'],
  planned: ['classified'],
  classified: ['ready', 'needs_review', 'classified', 'failed'],
  ready: ['dispatched', 'running', 'classified', 'needs_review', 'failed'],
  dispatched: ['running', 'failed', 'ready'],
  // A retry goes back to implement (ready); a node that cannot start fails or asks the maestro.
  running: ['verifying', 'failed', 'ready', 'needs_review'],
  // The graph's nodes after implement: done (merge next), merged (a spike's report), or back for a retry.
  verifying: ['done', 'needs_review', 'failed', 'verifying', 'ready', 'merged'],
  needs_review: ['approved', 'failed', 'ready', 'done', 'verifying'],
  approved: ['done'],
  done: ['merged', 'needs_review', 'failed'],
  merged: [],
  failed: ['ready'],
  cancelled: [],
}

export class TransitionError extends Error {}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (to === 'cancelled') return from !== 'merged' && from !== 'cancelled'
  return EDGES[from].includes(to)
}

export function assertTransition(task: Task, to: TaskStatus): void {
  if (!canTransition(task.status, to)) {
    throw new TransitionError(`task ${task.id}: ${task.status} -> ${to} is not allowed`)
  }
}

/**
 * A dependency is satisfied once merged into the run's integration branch:
 * the dependent task's worktree branches from there, so it sees the change.
 */
export function isReady(task: Task, all: readonly Task[]): boolean {
  const byId = new Map(all.map(t => [t.id, t]))
  return task.dependsOn.every(id => byId.get(id)?.status === 'merged')
}

/** A dependency that can no longer be merged blocks its dependents for good. */
export function isBlocked(task: Task, all: readonly Task[], isFinalFailure: (t: Task) => boolean): boolean {
  const byId = new Map(all.map(t => [t.id, t]))
  return task.dependsOn.some(id => {
    const dep = byId.get(id)
    if (dep === undefined || dep.status === 'cancelled') return true
    return dep.status === 'failed' && isFinalFailure(dep)
  })
}

/** Finds a dependency cycle, returning one of the ids on it. */
export function findCycle(tasks: readonly Task[]): string | undefined {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): string | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'visiting') return id
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const hit = visit(dep)
      if (hit !== undefined) return hit
    }
    state.set(id, 'done')
    return undefined
  }
  for (const t of tasks) {
    const hit = visit(t.id)
    if (hit !== undefined) return hit
  }
  return undefined
}
