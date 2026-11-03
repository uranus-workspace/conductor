// The graph engine (design doc §5B): pure functions over templates. It resolves
// edges, enforces the limits that live on them, checks who writes what, derives a
// task's status from where it stands, and draws the template and the path taken.
import type { TaskStatus } from '../core/domain.types.ts'
import type {
  Cursor, EdgeTarget, GraphTemplate, NodeId, NodeRun, StateField, TaskState, Terminal,
} from './graph.types.ts'

export class GraphError extends Error {}

/** Each field has exactly one owner: a node that writes another's field is a bug. */
export const OWNER: Readonly<Record<StateField, NodeId>> = {
  tasks: 'plan',
  acceptance: 'plan',
  dependsOn: 'plan',
  classification: 'route',
  template: 'route',
  notes: 'research',
  'attempt.result': 'implement',
  'attempt.diff': 'implement',
  'attempt.checks': 'check',
  'attempt.findings': 'security',
  'attempt.review': 'review',
  'attempt.verdict': 'judge',
  approval: 'human',
  mergedAt: 'merge',
  commit: 'merge',
  report: 'report',
}

export const TERMINALS: readonly Terminal[] = ['END', 'failed', 'needs_review']

export const isTerminal = (c: Cursor): c is Terminal => (TERMINALS as readonly string[]).includes(c)

/** Validates a node's writes at its boundary; throws on a field another node owns. */
export function checkWrites(node: NodeId, writes: readonly StateField[]): void {
  const foreign = writes.filter(f => OWNER[f] !== node)
  if (foreign.length > 0) {
    throw new GraphError(`${node} wrote ${foreign.map(f => `${f} (owned by ${OWNER[f]})`).join(', ')}`)
  }
}

/** The node's outgoing edge, resolved against the task's state. */
export function resolveEdge(template: GraphTemplate, from: NodeId, state: TaskState): EdgeTarget {
  const edge = template.edges.find(([f]) => f === from)
  if (edge === undefined) throw new GraphError(`template ${template.id} has no edge out of ${from}`)
  const to = edge[1]
  if (typeof to === 'function') return to(state)
  // A fixed edge is the success path; a node that failed goes back to its producer while the limits allow.
  if (state.outcome.status === 'fail') {
    const why = `${from} failed${state.outcome.reason ? `: ${state.outcome.reason.split('\n')[0]}` : ''}`
    return retryOr(state, from === 'research' ? 'research' : 'implement', 'failed', why)
  }
  return { to, reason: state.outcome.reason ?? (state.outcome.status === 'skip' ? `${from} skipped` : `${from} done`) }
}

/**
 * The retry edge: back to `node` while the limits allow, else `fallback`. Every
 * stopping rule lives here, on the edge, never inside a node.
 */
export function retryOr(s: TaskState, node: NodeId, fallback: Cursor, why: string): EdgeTarget {
  if (s.retries >= s.limits.maxRetries) return { to: fallback, reason: `${why}; out of retries (${s.retries}/${s.limits.maxRetries})`, rule: 'limits.maxRetries' }
  if (s.costUsd >= s.limits.maxCostUsd) return { to: fallback, reason: `${why}; out of budget (US$ ${s.costUsd.toFixed(2)})`, rule: 'limits.maxCostUsd' }
  if (s.minutes >= s.limits.maxMinutes) return { to: fallback, reason: `${why}; out of time (${Math.round(s.minutes)} min)`, rule: 'limits.maxMinutes' }
  return { to: node, reason: `${why}; retry ${s.retries + 1}/${s.limits.maxRetries} on a higher tier`, rule: 'retry', retry: true }
}

/** Every node a template can reach, entry first. */
export function nodesOf(template: GraphTemplate): NodeId[] {
  const out: NodeId[] = [template.entry]
  for (const [from] of template.edges) if (!out.includes(from)) out.push(from)
  return out
}

/**
 * The status is derived, never edited by hand: where the cursor stands says it.
 * `waiting` marks a job node whose process has not started (dispatch is capacity-bound).
 */
export function statusOf(cursor: Cursor, waiting: boolean): TaskStatus {
  switch (cursor) {
    case 'plan': return 'planned'
    case 'route': return 'classified'
    case 'research':
    case 'implement': return waiting ? 'ready' : 'running'
    case 'check':
    case 'security':
    case 'review':
    case 'judge':
    case 'report': return 'verifying'
    case 'human':
    case 'needs_review': return 'needs_review'
    case 'merge': return 'done'
    case 'END': return 'merged'
    case 'failed': return 'failed'
  }
}

const LABEL: Record<NodeId, string> = {
  plan: 'plan', route: 'route', research: 'research', implement: 'implement', check: 'check',
  security: 'security', review: 'review', judge: 'judge', human: 'human gate', merge: 'merge', report: 'report',
}

/**
 * The template as a Mermaid flowchart, with the path a task took: passed nodes
 * green, failed ones red, the cursor bold, every taken edge labelled with its reason.
 */
export function mermaid(template: GraphTemplate, runs: readonly NodeRun[] = [], cursor?: Cursor): string {
  const lines = [`flowchart LR`, `  %% ${template.id} v${template.version}: ${template.description}`]
  const ids = new Set<string>()
  const node = (id: Cursor) => {
    if (ids.has(id)) return id
    ids.add(id)
    const label = isTerminal(id) ? id : LABEL[id]
    lines.push(isTerminal(id) ? `  ${id}((${label}))` : `  ${id}[${label}]`)
    return id
  }
  node(template.entry)
  for (const [from, to] of template.edges) {
    node(from)
    if (typeof to === 'function') {
      lines.push(`  ${from} -. decides .-> ${from}_next{{${LABEL[from]}?}}`)
    } else {
      node(to)
      lines.push(`  ${from} --> ${to}`)
    }
  }
  for (const r of runs) {
    if (r.decision === undefined) continue
    node(r.decision.from)
    node(r.decision.to)
    const why = r.decision.reason.replace(/["|]/g, "'").slice(0, 60)
    lines.push(`  ${r.decision.from} == "${why}" ==> ${r.decision.to}`)
  }
  const passed = runs.filter(r => r.status !== 'fail').map(r => r.node)
  const failed = runs.filter(r => r.status === 'fail').map(r => r.node)
  lines.push('  classDef passed fill:#d1fae5,stroke:#059669')
  lines.push('  classDef failed fill:#fee2e2,stroke:#dc2626')
  lines.push('  classDef current stroke-width:3px,stroke:#2563eb')
  if (passed.length) lines.push(`  class ${[...new Set(passed)].join(',')} passed`)
  if (failed.length) lines.push(`  class ${[...new Set(failed)].join(',')} failed`)
  if (cursor) lines.push(`  class ${node(cursor)} current`)
  return lines.join('\n')
}
