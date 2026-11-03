import type { Task, TaskStatus } from '../../core/domain.types.ts'

/** What a move writes to the board: the new state and/or labels, and the note it carries. */
export interface BoardMove {
  /** The board's state to move to; undefined leaves the state alone. */
  state?: string
  /** The labels the item ends up with; undefined leaves them alone. */
  labels?: readonly string[]
  note?: string
  /** The Conductor status behind the move. */
  status: TaskStatus
}

/**
 * A task board reached over MCP (Uranus OS, Jira, Linear): where a run and its tasks
 * live for people. The RemoteTaskSource writes through it first; the local file keeps
 * what only this machine needs.
 */
export interface Board {
  /** Shown in notes: "cancelled on the <name> board". */
  readonly name: string
  /** Creates the run's container (epic, project); returns its key. */
  createRun(goal: string): Promise<string>
  /** Closes the run's container when the run completes or stops. */
  finishRun(runKey: string, outcome: 'completed' | 'stopped'): Promise<void>
  /** Creates the task's item under the run; returns its key (`PROJ-12`, `ENG-34`). */
  createTask(task: Task, runKey: string | undefined, description: string, labels: readonly string[]): Promise<string>
  /** Records that `blockerKey` blocks `blockedKey`. */
  relate(blockerKey: string, blockedKey: string): Promise<void>
  /** The board state a Conductor status maps to; undefined: the board has none for it (labels carry it). */
  stateFor(status: TaskStatus): string | undefined
  move(key: string, move: BoardMove): Promise<void>
  comment(key: string, body: string): Promise<void>
  /** A progress update on the run (a project update, a comment on the epic). */
  publishUpdate(runKey: string | undefined, body: string): Promise<void>
  /** Keys of the run's items cancelled on the board. */
  cancelledKeys(runKey: string): Promise<Set<string>>
  /** A read-only connection check, for /conduct source. */
  check(): Promise<string>
}
