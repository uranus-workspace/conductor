import type { ElementTable } from 'claude-code'

import type { ConductorBoardRow, ConductorSummary } from '../types'

/** The elements every surface draws. */
export type CommonElements = Pick<ElementTable, 'Box' | 'Text' | 'Button' | 'Markdown'>

/** `Svg`, on the surfaces that have it (the desktop and mobile apps). */
export type SvgElement = ElementTable<'desktop'>['Svg']

/** What the dashboard's buttons do; the hooks module wires them to the Conductor. */
export interface DashboardActions {
  approve(taskId: string): void
  reject(taskId: string): void
  retry(taskId: string): void
  graph(taskId: string): void
}

export interface BandInput {
  summary: ConductorSummary
  rows: readonly ConductorBoardRow[]
  columns: number
  maxRows: number
  nowMs: number
}

export interface DashboardInput {
  summary: ConductorSummary | null
  rows: readonly ConductorBoardRow[]
  columns: number
  nowMs: number
  actions: DashboardActions
  svg?: SvgElement
}
