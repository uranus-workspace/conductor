import type { GraphTemplate } from '../graph.types.ts'
import { afterCheck, afterJudge, afterReview } from './edges.ts'

/** New functionality with clear criteria: an independent review and a judge before merging. */
export const feature: GraphTemplate = {
  id: 'feature',
  version: 1,
  description: 'implement → check → review → judge → merge',
  entry: 'implement',
  edges: [
    ['implement', 'check'],
    ['check', afterCheck('review')],
    ['review', afterReview('judge')],
    ['judge', afterJudge('merge')],
    ['merge', 'END'],
  ],
  limits: { maxRetries: 2, maxCostUsd: 5, maxMinutes: 45 },
  merges: true,
}
