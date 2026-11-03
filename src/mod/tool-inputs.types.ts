import type { PlanInput, WorkerId } from '../core/domain.types.ts'

/** `conductor_plan`: the maestro's plan for a run. */
export interface PlanToolInput {
  runId?: string
  goal?: string
  tasks: PlanInput[]
}

/** `conductor_status`. */
export interface StatusToolInput {
  runId?: string
}

/** `conductor_approve`. */
export interface ApproveToolInput {
  taskId: string
  note?: string
}

/** `conductor_reject`. */
export interface RejectToolInput {
  taskId: string
  reason: string
  retry: boolean
  executor?: WorkerId
}

/** `conductor_dispatch`. */
export interface DispatchToolInput {
  taskId: string
  executor?: WorkerId
}

/** `ask_openrouter`. */
export interface AskOpenRouterToolInput {
  prompt: string
  model?: string
  system?: string
  maxTokens?: number
}
