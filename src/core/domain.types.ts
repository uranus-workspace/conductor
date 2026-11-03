// Domain types of the Conductor. Pure data: no engine import, so the core can
// be tested under plain Node as well as loaded by the mod engine.
import type { Cursor, NodeRun, Shard, TemplateId } from '../graph/graph.types.ts'

export type TaskStatus =
  | 'draft' | 'planned' | 'classified' | 'ready' | 'dispatched' | 'running'
  | 'verifying' | 'needs_review' | 'approved' | 'done' | 'merged' | 'failed' | 'cancelled'

export type ExecutorId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'antigravity' | 'openrouter'

/** Every worker has an adapter and an on/off switch; `openrouter` writes text, not code. */
export type WorkerId = ExecutorId
export type Tier = 'cheap' | 'standard' | 'strong'

export interface Classification {
  executor: ExecutorId
  tier: Tier
  complexity: number          // 1..5
  risk: number                // 1..5, deterministic floor already applied
  parallelizable: number      // 0..1
  needsHuman: number          // 0..1
  source: 'jev' | 'rules'
  model?: string
  confidence?: Record<string, number>
  /** The graph template the task walks (§5B); risk >= 4 always means `secure`. */
  template?: TemplateId
}

/** A detached process the heartbeat watches: one phase of an attempt. */
export interface Job {
  kind: 'research' | 'implement' | 'check' | 'security' | 'review'
  dir: string                 // absolute: pid, exit, out.log, err.log live here
  pid: number
  startedAt: string
  timeoutMs: number
  /** The worker the job runs, when it is one: what concurrency counts. */
  executor?: ExecutorId
}

export interface Attempt {
  executor: ExecutorId
  tier: Tier
  model?: string
  worktree: string
  branch: string
  /** Integration branch head the worktree started from: the diff base. */
  baseRef: string
  /** Folder of this attempt's logs, one sub-folder per job. */
  logDir: string
  startedAt: string
  finishedAt?: string
  exitCode?: number
  summary?: string
  diffStat?: string
  changedFiles?: string[]
  costUsd?: number
  costEstimated?: boolean
  tokens?: { input: number; output: number }
  verdict?: 'pass' | 'fail' | 'review'
  /** Who reviewed it: never the author's worker. */
  reviewer?: ExecutorId
  /** The security node's findings, when a scanner is configured. */
  findings?: string
  /** Fan-out groups of a refactor's implement node, each with its own worktree. */
  shards?: Shard[]
  error?: string
}

export interface Task {
  id: string
  runId: string
  key?: string                // the planner's local key, used to wire dependsOn
  title: string
  description: string
  acceptance: string[]
  files?: string[]
  dependsOn: string[]
  status: TaskStatus
  classification?: Classification
  /** Executor forced by the maestro (conductor_dispatch / retry), wins over routing. */
  forcedExecutor?: ExecutorId
  attempts: Attempt[]
  job?: Job
  /** Why the task sits where it is (failure reason, review request, ...). */
  note?: string
  /** Set when the maestro rejected without retry: automatic retries stop. */
  noRetry?: boolean
  /** The task's key in a remote task source (Uranus OS: `TCG-12`). */
  remoteKey?: string
  /** What the remote source last received, so unchanged writes are skipped. */
  remoteSync?: { status?: string; labels?: string; links?: string[] }
  /** Set once the maestro looked at it (approve/reject): a label for Jev. */
  reviewedByMaestro?: boolean
  client?: string
  labels?: string[]
  /** The graph template the task walks, and its version when it started. */
  template?: TemplateId
  templateVersion?: number
  /** Where the task stands in its template: its status is derived from it. */
  cursor?: Cursor
  /** When the task entered its cursor: the start of the node's run. */
  cursorSince?: string
  /** Every node passed, with the edge taken out of it: the task's checkpoints. */
  nodeRuns?: NodeRun[]
  /** The research node's notes (reproduction, context, design references): reused by every retry. */
  notes?: string
  /** A spike's report (where it was written). */
  report?: string
  /** The human gate's approval. */
  approval?: { by: string; at: string }
  /** Figma links the implement node gets design context from. */
  designRefs?: string[]
}

export interface Run {
  id: string
  goal: string
  createdAt: string
  status: 'planning' | 'active' | 'paused' | 'completed' | 'stopped'
  integrationBranch?: string
  baseRef?: string
  /** Signature of the last state the maestro was woken for: one wake per state. */
  lastWake?: string
  /** Merged count at the last published update. */
  lastUpdateAt?: number
  /** The run's epic in a remote task source (Uranus OS slug). */
  remoteKey?: string
  meta?: Record<string, unknown>
}

/** What the band draws; mirrored in types/index.d.ts for $.state. */
export interface RunSummary {
  runId: string
  goal: string
  status: Run['status']
  total: number
  merged: number
  running: number
  review: number
  failed: number
  costUsd: number
}

/** One row of the board pane. */
export interface BoardRow {
  id: string
  title: string
  status: TaskStatus
  who: string
  note: string
  worktree?: string
  isBusy: boolean
  /** A fan-out's part worktrees while their workers run (the edit guard covers them too). */
  busyWorktrees?: string[]
}

export interface PlanInput {
  key: string
  title: string
  description: string
  acceptance: string[]
  files?: string[]
  dependsOn?: string[]
  labels?: string[]
  client?: string
  /** Figma links for design references (the research and implement nodes get their context). */
  designRefs?: string[]
}

export interface RepoContext {
  /** Files other open tasks of the run declare, for the parallelizable check. */
  openTaskFiles: string[]
  available: ExecutorId[]
}

export interface Evidence {
  checksPassed: boolean | null   // null: no deterministic checks configured
  reviewVerdict?: 'pass' | 'fail' | 'review'
  diffStat?: string
  changedFiles: string[]
  checksOutput?: string
}

export interface ExecutorResult {
  ok: boolean
  exitCode: number
  summary: string
  costUsd?: number
  costEstimated?: boolean
  tokens?: { input: number; output: number }
  raw?: string
  error?: string
  /** Text-only workers: the file content `materialize` writes. */
  content?: string
}

export interface ReviewVerdict {
  verdict: 'pass' | 'fail' | 'review'
  summary: string
  issues: string[]
}

