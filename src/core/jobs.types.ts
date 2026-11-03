import type { Job } from './domain.types.ts'

export interface JobSpec {
  kind: Job['kind']
  dir: string
  cwd: string
  argv: string[]
  timeoutMs: number
  /** Variables removed from the child's environment (ANTHROPIC_API_KEY, ...). */
  unset?: string[]
  /** Variables set over the host environment. */
  env?: Record<string, string>
  /** Shell run in `cwd` before argv (setup); a failure ends the job. */
  pre?: string
}

export type JobState =
  | { state: 'running' }
  | { state: 'exited'; exitCode: number }
  | { state: 'lost' }
  | { state: 'timeout' }
