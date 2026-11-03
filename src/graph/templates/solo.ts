import type { GraphTemplate } from '../graph.types.ts'
import { afterCheck } from './edges.ts'

/** Trivial, low-risk work: one loop and the checks. The default. */
export const solo: GraphTemplate = {
  id: 'solo',
  version: 1,
  description: 'implement → check → merge',
  entry: 'implement',
  edges: [
    ['implement', 'check'],
    ['check', afterCheck('merge')],
    ['merge', 'END'],
  ],
  limits: { maxRetries: 2, maxCostUsd: 3, maxMinutes: 30 },
  merges: true,
}
