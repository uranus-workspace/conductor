// The mod's state contract: what the band and the panes read. It mirrors RunSummary and BoardRow
// (src/core/domain.types.ts); the mod's typecheck fails when the two drift apart.

export type ConductorWorker = 'claude' | 'codex' | 'cursor' | 'opencode' | 'antigravity' | 'openrouter'

export type ConductorWorkerUsage = {
  executor: ConductorWorker
  tasks: number
  attempts: number
  tokens: number
  costUsd: number
  estimated: boolean
}

export type ConductorSummary = {
  runId: string
  goal: string
  status: 'planning' | 'active' | 'paused' | 'completed' | 'stopped'
  total: number
  merged: number
  running: number
  review: number
  failed: number
  queued: number
  costUsd: number
  tokensIn: number
  tokensOut: number
  budgetRunUsd: number
  budgetDayUsd: number
  spentTodayUsd: number
  startedAt: string
  integrationBranch?: string
  byWorker: ConductorWorkerUsage[]
}

export type ConductorBoardRow = {
  id: string
  title: string
  status:
    | 'draft' | 'planned' | 'classified' | 'ready' | 'dispatched' | 'running'
    | 'verifying' | 'needs_review' | 'approved' | 'done' | 'merged' | 'failed' | 'cancelled'
  who: string
  note: string
  worktree?: string
  isBusy: boolean
  busyWorktrees?: string[]
  executor?: ConductorWorker
  tier?: 'cheap' | 'standard' | 'strong'
  attempts: number
  tokens: number
  costUsd: number
  template?: 'solo' | 'feature' | 'bugfix' | 'refactor' | 'secure' | 'spike'
  node?: string
  nodes: string[]
  nodeIndex: number
  runningSince?: string
  dependsOn: string[]
}

/** What the graph pane shows: one task's template and the path it took. */
export type ConductorGraph = {
  taskId: string
  mermaid: string
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    conductor: { summary: Shaped<ConductorSummary | null>; board: Shaped<ConductorBoardRow[]>; graph: ConductorGraph | null }
  }
}
