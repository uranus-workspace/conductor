import type { GraphTemplate } from '../graph.types.ts'
import { afterCheck, afterReview, afterSecurity } from './edges.ts'

/** Auth, billing, tax rules, migrations: a security scan, a review, and a human gate before merging. */
export const secure: GraphTemplate = {
  id: 'secure',
  version: 1,
  description: 'implement → check → security → review → human → merge',
  entry: 'implement',
  edges: [
    ['implement', 'check'],
    ['check', afterCheck('security')],
    ['security', afterSecurity('review')],
    ['review', afterReview('human')],
    ['human', 'merge'],
    ['merge', 'END'],
  ],
  limits: { maxRetries: 2, maxCostUsd: 8, maxMinutes: 60 },
  merges: true,
}
