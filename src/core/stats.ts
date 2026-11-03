// /conduct stats: what the metrics ledger says about a period, by worker, model, template and session.
import type { MetricRecord, SessionRow, StatsReport, TemplateRow, UsageRow } from './metrics.types.ts'
import { tokens, usd } from '../ui/format.ts'

const row = (key: string): UsageRow => ({ key, jobs: 0, ok: 0, failed: 0, durationMs: 0, costUsd: 0, tokens: 0 })

const byCost = <T extends { costUsd: number }>(rows: Iterable<T>): T[] => [...rows].sort((a, b) => b.costUsd - a.costUsd)

/** Errors that differ only in ids, paths or numbers count as one. */
export function errorShape(message: string): string {
  return message
    .replace(/\/[^\s'"]+/g, '<path>')
    .replace(/\b[a-z]+\d*-\d+(?:-\d+)*\b/gi, '<id>')
    .replace(/\d+/g, 'N')
    .slice(0, 120)
}

export function buildStats(records: readonly MetricRecord[], sinceMs: number, untilMs: number): StatsReport {
  const sessions = new Map<string, SessionRow>()
  const projects = new Set<string>()
  const executors = new Map<string, UsageRow>()
  const models = new Map<string, UsageRow>()
  const templates = new Map<string, TemplateRow>()
  const errors = new Map<string, number>()
  let runsCreated = 0
  let runsCompleted = 0
  let tasksMerged = 0
  let tasksFailed = 0
  let costUsd = 0
  let tokenCount = 0
  let peakJobs = 0
  let peakWorktrees = 0

  const usage = (map: Map<string, UsageRow>, key: string | undefined) => {
    if (key === undefined || key === '') return undefined
    const r = map.get(key) ?? row(key)
    map.set(key, r)
    return r
  }

  for (const r of records) {
    projects.add(r.project)
    const session = sessions.get(r.session) ?? { session: r.session, project: r.project, runs: 0, jobs: 0, costUsd: 0 }
    sessions.set(r.session, session)
    switch (r.kind) {
      case 'run.created':
        runsCreated++
        session.runs++
        break
      case 'run.finished':
        if (r.status === 'completed') runsCompleted++
        break
      case 'job.finished': {
        session.jobs++
        const ok = r.outcome === 'exited' && r.exitCode === 0
        for (const u of [usage(executors, r.executor), usage(models, r.model)]) {
          if (u === undefined) continue
          u.jobs++
          u.durationMs += r.durationMs
          if (ok) u.ok++
          else u.failed++
        }
        break
      }
      case 'node.finished': {
        const cost = r.costUsd ?? 0
        const tok = (r.tokensIn ?? 0) + (r.tokensOut ?? 0)
        costUsd += cost
        tokenCount += tok
        session.costUsd += cost
        for (const u of [usage(executors, r.executor), usage(models, r.model)]) {
          if (u === undefined) continue
          u.costUsd += cost
          u.tokens += tok
        }
        break
      }
      case 'task.finished': {
        if (r.status === 'merged') tasksMerged++
        else tasksFailed++
        const t = templates.get(r.template) ?? { template: r.template, merged: 0, failed: 0, attempts: 0, retries: 0, costUsd: 0 }
        if (r.status === 'merged') t.merged++
        else t.failed++
        t.attempts += r.attempts
        t.retries += r.retries
        t.costUsd += r.costUsd
        templates.set(r.template, t)
        break
      }
      case 'snapshot':
        peakJobs = Math.max(peakJobs, r.runningJobs)
        peakWorktrees = Math.max(peakWorktrees, r.worktrees)
        break
      case 'error': {
        const shape = errorShape(r.message)
        errors.set(shape, (errors.get(shape) ?? 0) + 1)
        break
      }
      case 'session.start':
      case 'session.end':
      case 'run.planned':
      case 'job.started':
        break
    }
  }

  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    sessions: sessions.size,
    projects: projects.size,
    runsCreated,
    runsCompleted,
    tasksMerged,
    tasksFailed,
    costUsd,
    tokens: tokenCount,
    byExecutor: byCost(executors.values()),
    byModel: byCost(models.values()),
    byTemplate: byCost(templates.values()),
    bySession: byCost(sessions.values()).slice(0, 10),
    peakJobs,
    peakWorktrees,
    errors: [...errors].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count).slice(0, 5),
  }
}

const pct = (part: number, whole: number) => (whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`)
const minutes = (ms: number, jobs: number) => (jobs === 0 ? '-' : `${(ms / jobs / 60_000).toFixed(1)} min`)
const tail = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

function usageLines(rows: readonly UsageRow[]): string[] {
  if (rows.length === 0) return ['  (none)']
  return rows.map(r =>
    `  ${r.key.padEnd(34)} ${`${r.jobs} job(s)`.padEnd(10)} ${`${pct(r.ok, r.jobs)} ok`.padEnd(8)} ${minutes(r.durationMs, r.jobs).padEnd(10)} ${`${tokens(r.tokens)} tok`.padEnd(11)} ${usd(r.costUsd)}`)
}

export function statsText(report: StatsReport): string {
  const finished = report.tasksMerged + report.tasksFailed
  const lines = [
    `Conductor, ${report.since.slice(0, 10)} to ${report.until.slice(0, 10)}`,
    `${report.sessions} session(s) in ${report.projects} project(s) · ${report.runsCreated} run(s), ${report.runsCompleted} completed · ${report.tasksMerged}/${finished} task(s) merged (${pct(report.tasksMerged, finished)})`,
    `${usd(report.costUsd)} · ${tokens(report.tokens)} tokens · at most ${report.peakJobs} job(s) and ${report.peakWorktrees} worktree(s) at once`,
    '',
    'By worker:',
    ...usageLines(report.byExecutor),
    '',
    'By model:',
    ...usageLines(report.byModel),
    '',
    'By template:',
    ...(report.byTemplate.length === 0
      ? ['  (none)']
      : report.byTemplate.map(t => {
          const n = t.merged + t.failed
          return `  ${t.template.padEnd(10)} ${`${t.merged}/${n} merged`.padEnd(14)} ${`${(t.attempts / Math.max(1, n)).toFixed(1)} attempt(s) each`.padEnd(22)} ${`${t.retries} retries`.padEnd(12)} ${usd(t.costUsd)}`
        })),
    '',
    'By session (most expensive first):',
    ...(report.bySession.length === 0
      ? ['  (none)']
      : report.bySession.map(s => `  ${s.session.slice(0, 8)}  ${tail(s.project).padEnd(24)} ${`${s.runs} run(s)`.padEnd(10)} ${`${s.jobs} job(s)`.padEnd(11)} ${usd(s.costUsd)}`)),
  ]
  if (report.errors.length > 0) {
    lines.push('', 'Most frequent errors:', ...report.errors.map(e => `  ${String(e.count).padStart(4)}×  ${e.message}`))
  }
  return lines.join('\n')
}
