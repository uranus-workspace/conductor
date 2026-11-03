import type { BoardRow, ExecutorId, RunSummary } from './domain.types.ts'

/** How the core reaches the person and the maestro; the mod implements it with `$`. */
export interface Notifier {
  toast(text: string): void
  /** Wakes the maestro with a prompt of its own once the session is idle. */
  wake(text: string): Promise<void>
  summary(summary: RunSummary | null): Promise<void>
  /** The board pane's rows; also tells the mod which worktrees are busy (its edit guard). */
  board(rows: BoardRow[]): Promise<void>
}

export interface WorkerStatus {
  id: ExecutorId
  enabled: boolean
  /** undefined: not probed, because the worker is switched off. */
  installed: boolean | undefined
  /** Why it cannot run, when it was probed and cannot. */
  reason?: string
}

/** Where design references (Figma links) become text a worker can use: the Figma MCP server, in the mod. */
export interface DesignSource {
  context(refs: readonly string[]): Promise<string>
}
