// Text the band and the dashboard draw: bars, counts, durations and status marks.
// Pure functions, so every surface (and the tests) gets the same output.
import type { TaskStatus } from '../core/domain.types.ts'
import type { BarCells, BudgetLevel, StatusLooks, TaskGroup, TrailStep } from './ui.types.ts'

export const usd = (n: number): string => `US$ ${n.toFixed(2)}`

export const STATUS_LOOK: StatusLooks = {
  draft: { icon: '○', tone: 'subtle' },
  planned: { icon: '○', tone: 'subtle' },
  classified: { icon: '○', tone: 'subtle' },
  ready: { icon: '○', tone: 'text' },
  dispatched: { icon: '◔', tone: 'claude' },
  running: { icon: '●', tone: 'claude' },
  verifying: { icon: '◑', tone: 'claude' },
  needs_review: { icon: '◆', tone: 'warning' },
  approved: { icon: '◆', tone: 'success' },
  done: { icon: '✔', tone: 'success' },
  merged: { icon: '✔', tone: 'success' },
  failed: { icon: '✖', tone: 'error' },
  cancelled: { icon: '⊘', tone: 'inactive' },
}

export const GROUP_ORDER: readonly TaskGroup[] = ['running', 'review', 'queued', 'done', 'failed']

export const GROUP_TITLE: Readonly<Record<TaskGroup, string>> = {
  running: 'Running',
  review: 'Needs review',
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
}

export function groupOf(status: TaskStatus): TaskGroup {
  switch (status) {
    case 'dispatched':
    case 'running':
    case 'verifying':
      return 'running'
    case 'needs_review':
      return 'review'
    case 'done':
    case 'merged':
      return 'done'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'draft':
    case 'planned':
    case 'classified':
    case 'ready':
    case 'approved':
      return 'queued'
  }
}

/**
 * A bar `width` cells wide: merged (█), in progress (▓), the rest (░). A part above zero always gets
 * a cell, and the bar is full only when everything is merged.
 */
export function bar(done: number, active: number, total: number, width: number): BarCells {
  const w = Math.max(1, Math.floor(width))
  if (total <= 0) return { done: '', active: '', rest: '░'.repeat(w) }
  const share = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round((n / total) * w)))
  let d = Math.min(w, share(done))
  if (done < total && d === w) d = w - 1
  const a = Math.min(w - d, share(active))
  return { done: '█'.repeat(d), active: '▓'.repeat(a), rest: '░'.repeat(w - d - a) }
}

/** `950`, `12.4k`, `120k`, `1.2M`. */
export function tokens(n: number): string {
  const short = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`
  if (n < 1000) return `${Math.max(0, Math.round(n))}`
  if (n < 1_000_000) return short(n / 1000, 'k')
  return short(n / 1_000_000, 'M')
}

/** `42s`, `3m 12s`, `1h 05m`; empty when `fromIso` is not a date. */
export function elapsed(fromIso: string, nowMs: number): string {
  const from = Date.parse(fromIso)
  if (Number.isNaN(from)) return ''
  const s = Math.max(0, Math.floor((nowMs - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function budgetLevel(spent: number, budget: number): BudgetLevel {
  if (budget <= 0) return 'ok'
  if (spent >= budget) return 'over'
  return spent >= budget * 0.8 ? 'warn' : 'ok'
}

export function percent(done: number, total: number): number {
  return total <= 0 ? 0 : Math.floor((done / total) * 100)
}

/** The template's nodes with the one the task stands at; `index` follows `BoardRow.nodeIndex`. */
export function nodeTrail(nodes: readonly string[], index: number): TrailStep[] {
  return nodes.map((node, i) => ({ node, state: i < index ? 'done' : i === index ? 'current' : 'todo' }))
}

/** `implement ▸ [check] ▸ review ▸ merge`. */
export function trailText(steps: readonly TrailStep[]): string {
  return steps.map(s => (s.state === 'current' ? `[${s.node}]` : s.node)).join(' ▸ ')
}
