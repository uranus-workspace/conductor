export type ConductorSummary = {
  runId: string
  goal: string
  status: 'planning' | 'active' | 'paused' | 'completed' | 'stopped'
  total: number
  merged: number
  running: number
  review: number
  failed: number
  costUsd: number
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
}

/** What the graph pane shows: one task's template and the path it took. */
export type ConductorGraph = {
  taskId: string
  mermaid: string
  path: string
}

declare module 'claude-code' {
  interface PluginState {
    conductor: { summary: ConductorSummary | null; board: Shaped<ConductorBoardRow[]>; graph: ConductorGraph | null }
  }
}
