// The run's views: the band above the prompt and the dashboard pane. They take the surface's
// elements and the published state; the hooks module (register.tsx) calls them from its render hooks.
import type { RenderElement } from 'claude-code'

import type { ConductorBoardRow } from '../types'
import {
  bar, budgetLevel, elapsed, GROUP_ORDER, GROUP_TITLE, groupOf, nodeTrail, percent, STATUS_LOOK, tokens, usd,
} from '../src/ui/format.ts'
import { statusBarSvg, workerCostSvg } from '../src/ui/svg.ts'
import type { BudgetLevel, Tone } from '../src/ui/ui.types.ts'
import type { BandInput, CommonElements, DashboardInput } from './views.types.ts'

const LEVEL_TONE: Readonly<Record<BudgetLevel, Tone | undefined>> = { ok: undefined, warn: 'warning', over: 'error' }

const RUN_ICON = { planning: '✎', active: '▶', paused: '⏸', completed: '✔', stopped: '■' } as const

const workerOf = (r: ConductorBoardRow) => (r.executor ? `${r.executor}${r.tier ? `/${r.tier}` : ''}` : r.who)

const nodeOf = (r: ConductorBoardRow) => r.node ?? r.nodes[r.nodeIndex] ?? ''

/** A text bar in its three colors. */
function TextBar(els: CommonElements, done: number, active: number, total: number, width: number, key: string): RenderElement {
  const { Text } = els
  const cells = bar(done, active, total, width)
  return (
    <Text key={key}>
      <Text color="success">{cells.done}</Text>
      <Text color="claude">{cells.active}</Text>
      <Text dimColor>{cells.rest}</Text>
    </Text>
  )
}

/**
 *  ▶ r1  ███████▓▓░░░  8/12  ● 2 running  ◆ 1 review  ✖ 1 failed  1.2M tok  US$ 4.10 / 50.00
 *     ● t3 codex/standard · implement · 3m 12s   ● t7 claude/strong · review · 41s
 */
export function band(els: CommonElements, input: BandInput): RenderElement {
  const { Box, Text } = els
  const { summary: s, rows, columns, maxRows, nowMs } = input
  const level = budgetLevel(s.costUsd, s.budgetRunUsd)
  const head = `${RUN_ICON[s.status]} ${s.runId}`
  const count = `${s.merged}/${s.total}`
  const flags = [
    { key: 'running', text: `● ${s.running} running`, tone: s.running > 0 ? 'claude' : undefined },
    ...(s.review > 0 ? [{ key: 'review', text: `◆ ${s.review} review`, tone: 'warning' }] : []),
    ...(s.failed > 0 ? [{ key: 'failed', text: `✖ ${s.failed} failed`, tone: 'error' }] : []),
  ]
  const tok = `${tokens(s.tokensIn + s.tokensOut)} tok`
  const cost = usd(s.costUsd)
  const budget = ` / ${s.budgetRunUsd.toFixed(2)}`
  // Fit the row: the token count goes first, then the budget, then the bar narrows.
  const fixed = head.length + count.length + flags.reduce((n, f) => n + f.text.length + 2, 0) + cost.length + 8
  let showTokens = true
  let showBudget = true
  let barWidth = 12
  if (fixed + barWidth + tok.length + budget.length > columns) showTokens = false
  if (fixed + barWidth + (showTokens ? tok.length : 0) + budget.length > columns) showBudget = false
  if (fixed + barWidth > columns) barWidth = Math.max(4, columns - fixed)
  const running = rows.filter(r => r.runningSince !== undefined).slice(0, 3)
  return (
    <Box flexDirection="column">
      <Text>
        <Text weight="bold">{head}</Text>
        {'  '}
        {TextBar(els, s.merged, s.running, s.total, barWidth, 'band-bar')}
        {'  '}
        <Text tabular>{count}</Text>
        {flags.map(f => (
          <Text key={`band-${f.key}`} color={f.tone} dimColor={f.tone === undefined}>{`  ${f.text}`}</Text>
        ))}
        {showTokens && <Text dimColor>{`  ${tok}`}</Text>}
        <Text color={LEVEL_TONE[level]}>{`  ${cost}`}</Text>
        {showBudget && <Text dimColor>{budget}</Text>}
      </Text>
      {maxRows >= 2 && running.length > 0 && (
        <Text dimColor>
          {'   '}
          {running
            .map(r => `● ${r.id} ${workerOf(r)} · ${nodeOf(r)} · ${elapsed(r.runningSince ?? '', nowMs)}`)
            .join('   ')
            .slice(0, Math.max(10, columns - 3))}
        </Text>
      )}
    </Box>
  )
}

function tile(els: CommonElements, key: string, label: string, value: string, sub: string | undefined, tone: Tone | undefined): RenderElement {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1} minWidth={16}>
      <Text dimColor size="caption">{label}</Text>
      <Text weight="bold" tabular color={tone}>{value}</Text>
      {sub !== undefined && <Text dimColor size="caption">{sub}</Text>}
    </Box>
  )
}

function taskRow(els: CommonElements, r: ConductorBoardRow, input: DashboardInput): RenderElement {
  const { Box, Text, Button } = els
  const { actions, columns, nowMs } = input
  const look = STATUS_LOOK[r.status]
  const steps = nodeTrail(r.nodes, r.nodeIndex)
  const facts = [
    `${tokens(r.tokens)} tok`,
    usd(r.costUsd),
    ...(r.attempts > 1 ? [`attempt ${r.attempts}`] : []),
    ...(r.runningSince ? [elapsed(r.runningSince, nowMs)] : []),
  ].join(' · ')
  return (
    <Box key={`task-${r.id}`} flexDirection="column">
      <Text>
        <Text color={look.tone}>{look.icon}</Text>
        <Text weight="semibold">{` ${r.id}`}</Text>
        {` ${r.title.slice(0, Math.max(12, columns - r.id.length - 28))}`}
        <Text dimColor>{`  ${workerOf(r)}`}</Text>
      </Text>
      <Text>
        {'   '}
        {steps.map((step, i) => (
          <Text
            key={`trail-${r.id}-${step.node}`}
            color={step.state === 'current' ? look.tone : step.state === 'done' ? 'success' : undefined}
            weight={step.state === 'current' ? 'bold' : undefined}
            dimColor={step.state === 'todo'}
          >
            {`${i > 0 ? ' ▸ ' : ''}${step.node}`}
          </Text>
        ))}
        <Text dimColor>{`   ${facts}`}</Text>
      </Text>
      {r.note !== '' && <Text dimColor>{`   ${r.note.slice(0, Math.max(10, columns - 4))}`}</Text>}
      {(r.status === 'needs_review' || r.status === 'failed' || r.nodes.length > 0) && (
        <Box gap={1}>
          {r.status === 'needs_review' && <Button key={`approve-${r.id}`} label="Approve" onPress={() => actions.approve(r.id)} />}
          {r.status === 'needs_review' && <Button key={`reject-${r.id}`} label="Retry" onPress={() => actions.reject(r.id)} />}
          {r.status === 'failed' && <Button key={`retry-${r.id}`} label="Retry" onPress={() => actions.retry(r.id)} />}
          {r.nodes.length > 0 && <Button key={`graph-${r.id}`} label="Graph" onPress={() => actions.graph(r.id)} />}
        </Box>
      )}
    </Box>
  )
}

/** The dashboard pane: progress, the numbers that matter, cost by worker, then every task by state. */
export function dashboard(els: CommonElements, input: DashboardInput): RenderElement {
  const { Box, Text } = els
  const { summary: s, rows, columns, nowMs, svg: Svg } = input
  if (s === null) {
    return (
      <Box>
        <Text dimColor>No run yet. Start one with /conduct plan &lt;goal&gt;.</Text>
      </Box>
    )
  }
  const pct = percent(s.merged, s.total)
  const runLevel = budgetLevel(s.costUsd, s.budgetRunUsd)
  const dayLevel = budgetLevel(s.spentTodayUsd, s.budgetDayUsd)
  const svgWidth = Math.min(640, Math.max(240, columns * 7))
  const counts = { merged: s.merged, running: s.running, review: s.review, failed: s.failed, queued: Math.max(0, s.total - s.merged - s.running - s.review - s.failed) }
  const groups = GROUP_ORDER.map(g => ({ group: g, rows: rows.filter(r => groupOf(r.status) === g) })).filter(g => g.rows.length > 0)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text weight="bold" size="heading">{s.goal}</Text>
        <Text dimColor>
          {`${RUN_ICON[s.status]} ${s.status} · ${s.runId} · started ${elapsed(s.startedAt, nowMs)} ago${s.integrationBranch ? ` · ${s.integrationBranch}` : ''}`}
        </Text>
      </Box>

      <Box flexDirection="column">
        {Svg !== undefined ? (
          <Svg key="status-svg" source={statusBarSvg(counts, svgWidth)} alt={`${s.merged} of ${s.total} tasks merged`} />
        ) : (
          TextBar(els, s.merged, s.running, s.total, Math.max(10, columns - 2), 'dash-bar')
        )}
        <Text>
          <Text weight="semibold">{`${s.merged} of ${s.total} merged`}</Text>
          <Text dimColor>{` · ${pct}%`}</Text>
        </Text>
      </Box>

      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {tile(els, 'tile-running', 'Running', `${s.running}`, `${counts.queued} queued`, s.running > 0 ? 'claude' : undefined)}
        {tile(els, 'tile-review', 'Review', `${s.review}`, undefined, s.review > 0 ? 'warning' : undefined)}
        {tile(els, 'tile-failed', 'Failed', `${s.failed}`, undefined, s.failed > 0 ? 'error' : undefined)}
        {tile(els, 'tile-tokens', 'Tokens', tokens(s.tokensIn + s.tokensOut), `${tokens(s.tokensIn)} in · ${tokens(s.tokensOut)} out`, undefined)}
        {tile(els, 'tile-cost', 'Run cost', usd(s.costUsd), `of ${usd(s.budgetRunUsd)}`, LEVEL_TONE[runLevel])}
        {tile(els, 'tile-today', 'Today', usd(s.spentTodayUsd), `of ${usd(s.budgetDayUsd)}`, LEVEL_TONE[dayLevel])}
      </Box>

      {s.byWorker.length > 0 && (
        <Box flexDirection="column">
          <Text weight="semibold">Workers</Text>
          {Svg !== undefined && (
            <Svg key="workers-svg" source={workerCostSvg(s.byWorker, svgWidth)} alt="Cost by worker" />
          )}
          {s.byWorker.map(w => (
            <Text key={`worker-${w.executor}`} dimColor={Svg !== undefined}>
              {`${w.executor.padEnd(12)}${`${w.tasks} task(s)`.padEnd(11)}${`${w.attempts} attempt(s)`.padEnd(14)}${`${tokens(w.tokens)} tok`.padEnd(11)}${usd(w.costUsd)}${w.estimated ? ' *' : ''}`}
            </Text>
          ))}
          {s.byWorker.some(w => w.estimated) && <Text dimColor size="caption">* some costs were not reported, or are estimates</Text>}
        </Box>
      )}

      {groups.map(g => (
        <Box key={`group-${g.group}`} flexDirection="column">
          <Text weight="semibold">{`${GROUP_TITLE[g.group]} (${g.rows.length})`}</Text>
          {g.rows.map(r => taskRow(els, r, input))}
        </Box>
      ))}
    </Box>
  )
}
