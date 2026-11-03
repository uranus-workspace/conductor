import type { GraphTemplate } from '../graph.types.ts'
import { afterCheck, afterResearch, afterReview } from './edges.ts'

/** A bug with a known symptom: reproduce first, fix, then a regression check and a review. */
export const bugfix: GraphTemplate = {
  id: 'bugfix',
  version: 1,
  description: 'research (reproduce) → implement → check (regression) → review → merge',
  entry: 'research',
  edges: [
    ['research', afterResearch('implement')],
    ['implement', 'check'],
    ['check', afterCheck('review')],
    ['review', afterReview('merge')],
    ['merge', 'END'],
  ],
  limits: { maxRetries: 2, maxCostUsd: 5, maxMinutes: 45 },
  merges: true,
}
