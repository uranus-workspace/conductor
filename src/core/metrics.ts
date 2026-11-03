// Append-only logs without an append call: lines wait in memory and each flush adds them to their
// file. Files are per day (and per session for metrics), so every read-and-write stays small.
import type { Host } from './host.types.ts'
import { isJsonObject, tryParse } from './json.ts'
import type { MetricEvent, MetricRecord, MetricsSink, MetricsTarget } from './metrics.types.ts'
import { redact } from './redact.ts'

export class AppendBuffer {
  private readonly host: Host
  private pending = new Map<string, string[]>()
  private chain: Promise<void> = Promise.resolve()

  constructor(host: Host) {
    this.host = host
  }

  add(path: string, line: string): void {
    const lines = this.pending.get(path) ?? []
    lines.push(line.endsWith('\n') ? line : `${line}\n`)
    this.pending.set(path, lines)
  }

  /** Writes what is pending; flushes run one after another, and a failed write drops only its lines. */
  flush(): Promise<void> {
    const batch = this.pending
    this.pending = new Map()
    this.chain = this.chain.then(async () => {
      for (const [path, lines] of batch) {
        try {
          const before = (await this.host.read(path)) ?? ''
          await this.host.write(path, `${before}${lines.join('')}`)
        } catch {
          // A log must never stop the Conductor.
        }
      }
    })
    return this.chain
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Where the ledger lives: the config's folder, else ~/.conductor/metrics (shared by every project). */
export function metricsDirOf(dir: string, home: string): string {
  return dir === '' ? `${home}/.conductor/metrics` : dir
}

/** The metrics ledger: ~/.conductor/metrics/<YYYY-MM>/<YYYY-MM-DD>-<session>.jsonl. */
export class MetricsLog implements MetricsSink {
  private readonly buffer: AppendBuffer
  private readonly target: MetricsTarget
  private readonly clock: () => number

  constructor(buffer: AppendBuffer, target: MetricsTarget, clock: () => number = Date.now) {
    this.buffer = buffer
    this.target = target
    this.clock = clock
  }

  record(event: MetricEvent): void {
    const at = iso(this.clock())
    const record: MetricRecord = { v: 1, at, session: this.target.session, project: this.target.project, ...scrub(event) }
    this.buffer.add(`${this.target.dir}/${at.slice(0, 7)}/${at.slice(0, 10)}-${this.target.session.slice(0, 8)}.jsonl`, JSON.stringify(record))
  }
}

/** Free text (goals, reasons, errors) is redacted and cut short before it is written. */
function scrub(event: MetricEvent): MetricEvent {
  const text = (s: string, max = 300) => redact(s).slice(0, max)
  switch (event.kind) {
    case 'run.created':
      return { ...event, goal: text(event.goal, 200) }
    case 'node.finished':
    case 'task.finished':
      return { ...event, reason: text(event.reason) }
    case 'error':
      return { ...event, message: text(event.message, 500) }
    default:
      return event
  }
}

/** The project's own log: .conductor/logs/conductor-<YYYY-MM-DD>.log, one line per message. */
export class LineLog {
  private readonly buffer: AppendBuffer
  private readonly dir: string
  private readonly clock: () => number

  constructor(buffer: AppendBuffer, dir: string, clock: () => number = Date.now) {
    this.buffer = buffer
    this.dir = dir
    this.clock = clock
  }

  write(level: 'info' | 'error', message: string): void {
    const at = iso(this.clock())
    this.buffer.add(`${this.dir}/conductor-${at.slice(0, 10)}.log`, `${at} ${level.padEnd(5)} ${redact(message).replace(/\n/g, ' ⏎ ')}`)
  }
}

const KINDS = new Set<string>([
  'session.start', 'session.end', 'run.created', 'run.planned', 'run.finished', 'job.started', 'job.finished',
  'node.finished', 'task.finished', 'snapshot', 'error',
])

export function isMetricRecord(value: unknown): value is MetricRecord {
  if (!isJsonObject(value)) return false
  const r = value
  return r.v === 1 && typeof r.kind === 'string' && KINDS.has(r.kind) && typeof r.at === 'string' && typeof r.session === 'string' && typeof r.project === 'string'
}

/** Every record since `sinceMs`, oldest first; torn lines (a crash mid-write) are skipped. */
export async function readMetrics(host: Host, dir: string, sinceMs: number): Promise<MetricRecord[]> {
  const sinceMonth = iso(sinceMs).slice(0, 7)
  const sinceDay = iso(sinceMs).slice(0, 10)
  const out: MetricRecord[] = []
  for (const month of (await host.list(dir)).filter(m => /^\d{4}-\d{2}$/.test(m) && m >= sinceMonth).sort()) {
    for (const name of (await host.list(`${dir}/${month}`)).filter(n => n.endsWith('.jsonl') && n.slice(0, 10) >= sinceDay).sort()) {
      for (const line of ((await host.read(`${dir}/${month}/${name}`)) ?? '').split('\n')) {
        if (line.trim() === '') continue
        const record = tryParse(line)
        if (isMetricRecord(record) && Date.parse(record.at) >= sinceMs) out.push(record)
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}
