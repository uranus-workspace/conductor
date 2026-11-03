import type { ExecutorId, TaskStatus } from '../core/domain.types.ts'

/** Spend against a budget: `warn` from 80%, `over` from 100%. */
export type BudgetLevel = 'ok' | 'warn' | 'over'

/** Theme colors every surface maps to its own palette. */
export type Tone = 'text' | 'subtle' | 'inactive' | 'success' | 'error' | 'warning' | 'claude'

/** A text progress bar in three runs of cells, so each can take its own color. */
export interface BarCells {
  done: string
  active: string
  rest: string
}

/** One node of a task's template, as the dashboard draws its trail. */
export interface TrailStep {
  node: string
  state: 'done' | 'current' | 'todo'
}

/** The dashboard's sections, in the order they are drawn. */
export type TaskGroup = 'running' | 'review' | 'queued' | 'done' | 'failed'

/** Task counts by group, for the stacked status bar. */
export interface StatusCounts {
  merged: number
  running: number
  review: number
  failed: number
  queued: number
}

/** One bar of the cost-by-worker chart. */
export interface WorkerBar {
  executor: ExecutorId
  costUsd: number
  tokens: number
}

/** What a status looks like: its icon and its color. */
export interface StatusLook {
  icon: string
  tone: Tone
}

export type StatusLooks = Readonly<Record<TaskStatus, StatusLook>>
