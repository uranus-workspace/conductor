import type { Task } from '../../core/domain.types.ts'
import type { GraphTemplate } from '../graph.types.ts'
import { afterCheck, afterReview } from './edges.ts'

const MAX_SHARDS = 4

/** The task's files grouped by top-level folder, at most MAX_SHARDS groups (the last absorbs the rest). */
export function byModule(task: Task): string[][] {
  const groups = new Map<string, string[]>()
  for (const f of task.files ?? []) {
    const key = f.includes('/') ? f.slice(0, f.indexOf('/')) : '.'
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const list = [...groups.values()]
  if (list.length <= MAX_SHARDS) return list.length ? list : [task.files ?? []]
  return [...list.slice(0, MAX_SHARDS - 1), list.slice(MAX_SHARDS - 1).flat()]
}

/** The same mechanical change across many files: one implement per module in parallel, then one check and review. */
export const refactor: GraphTemplate = {
  id: 'refactor',
  version: 1,
  description: 'fan-out implement per module → fan-in → check → review → merge',
  entry: 'implement',
  edges: [
    ['implement', 'check'],
    ['check', afterCheck('review')],
    ['review', afterReview('merge')],
    ['merge', 'END'],
  ],
  fanOut: { node: 'implement', by: byModule },
  limits: { maxRetries: 1, maxCostUsd: 8, maxMinutes: 60 },
  merges: true,
}
