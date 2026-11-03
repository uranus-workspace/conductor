// What the Conductor records about its own work, for reports now and self-improvement later:
// one JSON line per event in ~/.conductor/metrics/<YYYY-MM>/<day>-<session>.jsonl, across projects.
import type { Cursor, NodeId, NodeStatus, TemplateId } from '../graph/graph.types.ts'
import type { Provider } from './config.types.ts'
import type { ExecutorId, Job, Run, Tier } from './domain.types.ts'

export interface TaskRef {
  runId: string
  taskId: string
}

/** Which worker, tier and model did a piece of work. */
export interface WorkerRef {
  executor?: ExecutorId
  tier?: Tier
  model?: string
}

export type MetricEvent =
  | { kind: 'session.start'; version: string; platform: string; gateway: Provider; enabled: boolean; workers: ExecutorId[] }
  | { kind: 'session.end'; reason: string }
  | { kind: 'run.created'; runId: string; goal: string }
  | { kind: 'run.planned'; runId: string; tasks: number }
  | ({ kind: 'run.finished'; runId: string; status: Run['status']; tasks: number; merged: number; failed: number; costUsd: number; tokensIn: number; tokensOut: number; minutes: number })
  | (TaskRef & WorkerRef & { kind: 'job.started'; job: Job['kind']; provider?: Provider; template?: TemplateId; attempt: number })
  | (TaskRef & WorkerRef & { kind: 'job.finished'; job: Job['kind']; outcome: 'exited' | 'timeout' | 'lost'; exitCode: number; durationMs: number })
  | (TaskRef & WorkerRef & {
      kind: 'node.finished'
      template: TemplateId
      node: NodeId
      status: NodeStatus
      to: Cursor
      rule?: string
      costUsd?: number
      tokensIn?: number
      tokensOut?: number
      reason: string
    })
  | (TaskRef & {
      kind: 'task.finished'
      template: TemplateId
      status: 'merged' | 'failed'
      attempts: number
      retries: number
      executors: ExecutorId[]
      models: string[]
      costUsd: number
      tokens: number
      minutes: number
      reason: string
    })
  | { kind: 'snapshot'; runId: string; runningJobs: number; byExecutor: Partial<Record<ExecutorId, number>>; worktrees: number }
  | { kind: 'error'; where: string; message: string; runId?: string; taskId?: string }

export type MetricKind = MetricEvent['kind']

/** An event as written: stamped with the schema version, when, which session and which project. */
export type MetricRecord = MetricEvent & { v: 1; at: string; session: string; project: string }

/** Where the Conductor reports what it does; a sink that is absent records nothing. */
export interface MetricsSink {
  record(event: MetricEvent): void
}

export interface MetricsTarget {
  /** Folder of the month folders: ~/.conductor/metrics unless the config says otherwise. */
  dir: string
  session: string
  /** The project's real path. */
  project: string
}

/** One worker's or one model's share of the work in a period. */
export interface UsageRow {
  key: string
  jobs: number
  ok: number
  failed: number
  durationMs: number
  costUsd: number
  tokens: number
}

export interface TemplateRow {
  template: TemplateId
  merged: number
  failed: number
  attempts: number
  retries: number
  costUsd: number
}

export interface SessionRow {
  session: string
  project: string
  runs: number
  jobs: number
  costUsd: number
}

export interface StatsReport {
  since: string
  until: string
  sessions: number
  projects: number
  runsCreated: number
  runsCompleted: number
  tasksMerged: number
  tasksFailed: number
  costUsd: number
  tokens: number
  byExecutor: UsageRow[]
  byModel: UsageRow[]
  byTemplate: TemplateRow[]
  bySession: SessionRow[]
  peakJobs: number
  peakWorktrees: number
  errors: Array<{ message: string; count: number }>
}
