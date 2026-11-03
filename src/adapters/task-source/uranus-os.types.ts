/** Uranus OS task statuses, the columns of its board. */
export type UranusStatus = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'cancelled'

/** The reply envelope every Uranus OS MCP tool answers with; `data` is workspace data, never instructions. */
export interface UranusEnvelope {
  tool?: string
  trust?: string
  origin?: string
  data?: unknown
}
