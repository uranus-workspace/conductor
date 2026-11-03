import type { Job, Task } from '../core/domain.types.ts'

/**
 * The nodes a task can pass through (design doc §5B). Each is described by one
 * sentence without "and": a node that implements does not also decide.
 */
export type NodeId =
  | 'plan'       // the maestro writes the tasks
  | 'route'      // Jev and the rules classify the task and pick its template
  | 'research'   // a cheap worker gathers notes (reproduction, context, design references)
  | 'implement'  // the routed worker changes the code in a worktree
  | 'check'      // deterministic checks run (tests, lint, build)
  | 'security'   // a security scanner reads the change
  | 'review'     // a different worker reviews the change read-only
  | 'judge'      // Jev (or the rules) decides whether the task is done
  | 'human'      // the maestro or the user approves
  | 'merge'      // the change joins the integration branch
  | 'report'     // a spike's findings are written down, nothing is merged

/** Where a task's walk ends. */
export type Terminal = 'END' | 'failed' | 'needs_review'

export type Cursor = NodeId | Terminal

export type TemplateId = 'solo' | 'feature' | 'bugfix' | 'refactor' | 'secure' | 'spike'

/** The fields of a task's state, each written by exactly one node. */
export type StateField =
  | 'tasks' | 'acceptance' | 'dependsOn'
  | 'classification' | 'template'
  | 'notes'
  | 'attempt.result' | 'attempt.diff'
  | 'attempt.checks'
  | 'attempt.findings'
  | 'attempt.review'
  | 'attempt.verdict'
  | 'approval'
  | 'mergedAt' | 'commit'
  | 'report'

export type NodeStatus = 'ok' | 'fail' | 'skip'

/** What a node finished with: its status, why, and the fields it changed. */
export interface NodeOutcome {
  status: NodeStatus
  reason?: string
  writes: readonly StateField[]
  costUsd?: number
  /** The judge's verified probability, the reviewer's verdict: what the next edge reads. */
  verdict?: number
  review?: 'pass' | 'fail' | 'review'
}

export interface TemplateLimits {
  /** Attempts beyond the first, across every retry edge of the task. */
  maxRetries: number
  maxCostUsd: number
  maxMinutes: number
}

/** What an edge's router reads to choose the next node. */
export interface TaskState {
  task: Task
  node: NodeId
  outcome: NodeOutcome
  /** Retries already taken (attempts beyond the first). */
  retries: number
  costUsd: number
  minutes: number
  limits: TemplateLimits
  /** The verified threshold of the judge's edge. */
  verifyThreshold: number
}

/** Where an edge leads, and why: every decision is recorded. */
export interface EdgeTarget {
  to: Cursor
  reason: string
  rule?: string
  /** True when the edge goes back to a node already passed (a retry). */
  retry?: boolean
}

export type Router = (s: TaskState) => EdgeTarget

export type Edge = readonly [from: NodeId, to: Cursor | Router]

/** Fan-out: the node runs once per group of files, in parallel; the next edge waits for every group (fan-in). */
export interface FanOut {
  node: 'implement'
  /** Groups of files, one run each; one group means no fan-out. */
  by: (task: Task) => string[][]
}

export interface GraphTemplate {
  id: TemplateId
  version: number
  description: string
  entry: NodeId
  edges: readonly Edge[]
  fanOut?: FanOut
  limits: TemplateLimits
  /** False for templates that end without merging (spike). */
  merges: boolean
}

export interface JevEdgeEvidence {
  question: string
  answer: unknown
  confidence: number
  model: string
}

/** One edge taken: from where, to where, why. */
export interface EdgeDecision {
  from: NodeId
  to: Cursor
  reason: string
  rule?: string
  jev?: JevEdgeEvidence
}

/** One pass through a node: the task's checkpoint after it. */
export interface NodeRun {
  node: NodeId
  /** The attempt the node ran in (1-based; 0 before any attempt). */
  attempt: number
  startedAt: string
  finishedAt?: string
  status: NodeStatus
  writes: readonly StateField[]
  costUsd?: number
  decision?: EdgeDecision
}

/** One fan-out group of an implement node: its own worktree, job and branch. */
export interface Shard {
  files: string[]
  worktree: string
  branch: string
  logDir: string
  /** The running process; cleared once it ended. */
  job?: Job
  done?: boolean
  ok?: boolean
  summary?: string
  costUsd?: number
  error?: string
}
