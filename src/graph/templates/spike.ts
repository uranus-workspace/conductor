import type { GraphTemplate } from '../graph.types.ts'
import { afterResearch } from './edges.ts'

/** Investigation, a proof of concept, an architecture decision: findings, nothing to merge. */
export const spike: GraphTemplate = {
  id: 'spike',
  version: 1,
  description: 'research → report (no merge)',
  entry: 'research',
  edges: [
    ['research', afterResearch('report')],
    ['report', 'END'],
  ],
  limits: { maxRetries: 1, maxCostUsd: 2, maxMinutes: 30 },
  merges: false,
}
