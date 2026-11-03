import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { ExecutorId, ExecutorResult, ReviewVerdict, Task } from '../../core/domain.types.ts'

export interface ExecutorRequest {
  task: Task
  worktree: string            // absolute, already created
  logDir: string              // absolute, the job's folder
  prompt: string
  model?: string
  mode: 'implement' | 'review'
  timeoutMs: number
  budgetUsd?: number
  /** The OpenRouter key, when the executor's provider is OpenRouter and the environment has one. */
  openrouterKey?: string
  /** Review mode: absolute path of the JSON schema the verdict must follow. */
  schemaPath?: string
  /** The deterministic checks the worker is told to run: workers with command allow-lists permit exactly these. */
  checks?: readonly string[]
}

/** Whether a worker can run now, and why not when it cannot. */
export type Availability = { ok: true } | { ok: false; reason: string }

export interface ExecutorCommand {
  argv: string[]
  env?: Record<string, string>
  unset?: string[]
}

/**
 * Doc §6's `Executor.run` split in two: workers run detached (scripts/job.sh),
 * so an executor builds the command and later reads what the job left.
 */
export interface Executor {
  id: ExecutorId
  config: ExecutorConfig
  available(host: Host): Promise<Availability>
  command(req: ExecutorRequest): ExecutorCommand
  collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult>
  /** Review mode only: the verdict, or undefined when the reviewer produced none (fail closed). */
  verdict?(host: Host, logDir: string, exitCode: number): Promise<ReviewVerdict | undefined>
  /** Writes what the job needs before it starts (a request body), into its log folder. */
  prepare?(host: Host, req: ExecutorRequest): Promise<void>
  /** Turns a text answer into files in the worktree, before the commit (text-only workers). */
  materialize?(host: Host, req: { task: Task; worktree: string }, result: ExecutorResult): Promise<void>
}
