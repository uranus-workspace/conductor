import type { Host } from '../../core/host.types.ts'
import { riskFloor, tierFor } from '../../core/routing.ts'
import { iso } from '../../core/time.ts'
import type { Classification, Evidence, RepoContext, Task } from '../../core/domain.types.ts'
import type { DecisionMode } from '../../core/config.types.ts'
import type { DecisionModel, DecisionRecord, LabelRecord, Thresholds, Verification } from './decision.types.ts'
import { isJsonObject, tryParse } from '../../core/json.ts'

export const DEFAULT_THRESHOLDS: Thresholds = { executor: 0.6, complexity: 0.5, risk: 0.5, needsHuman: 0.6, template: 0.6 }

/** Append-only JSONL under `.conductor/jev/`, one file per month (each read stays under 4 MiB). */
export class DecisionLog {
  private readonly host: Host
  private readonly dir: string

  constructor(host: Host, dir: string) {
    this.host = host
    this.dir = dir
  }

  async append(record: DecisionRecord | LabelRecord): Promise<void> {
    const month = record.at.slice(0, 7)
    const path = `${this.dir}/${month}.jsonl`
    const before = (await this.host.read(path)) ?? ''
    await this.host.write(path, `${before}${JSON.stringify(record)}\n`)
  }

  async readAll(): Promise<Array<DecisionRecord | LabelRecord>> {
    const out: Array<DecisionRecord | LabelRecord> = []
    for (const name of (await this.host.list(this.dir)).filter(n => n.endsWith('.jsonl')).sort()) {
      for (const line of ((await this.host.read(`${this.dir}/${name}`)) ?? '').split('\n')) {
        if (line.trim() === '') continue
        // A torn line from a crash, or one of an unknown kind, is skipped.
        const record = tryParse(line)
        if (isLogRecord(record)) out.push(record)
      }
    }
    return out
  }
}

const KINDS: ReadonlySet<string> = new Set(['classify', 'verify', 'monitor', 'label'])

/** A log line written by this module: its kind and task are checked, its body is ours. */
export function isLogRecord(v: unknown): v is DecisionRecord | LabelRecord {
  return isJsonObject(v) && typeof v.kind === 'string' && KINDS.has(v.kind) && typeof v.taskId === 'string' && typeof v.at === 'string'
}

const certainty = (p: number) => Math.abs(p - 0.5) * 2

/**
 * The rollout of doc §7.3 in one place. `rules`: Jev is not asked. `shadow`:
 * the rules decide, Jev's answer is only logged. `enforce`: each of Jev's
 * answers is used where it clears its threshold, the rules' otherwise; a Jev
 * that fails or times out falls back to the rules (fail open), while hard
 * facts (failed checks, no change) stay with the code (fail closed).
 * Every decision is logged; `label` records outcomes; a share of calls is
 * asked twice, reshuffled, to measure consistency.
 */
export class DecisionRouter implements DecisionModel {
  private readonly rules: DecisionModel
  private readonly jev: DecisionModel | undefined
  private readonly mode: DecisionMode
  private readonly thresholds: Thresholds
  private readonly log: DecisionLog
  private readonly host: Host
  private readonly riskPaths: readonly string[]
  private readonly monitorRate: number
  private readonly random: () => number

  constructor(opts: {
    host: Host
    rules: DecisionModel
    jev?: DecisionModel
    mode: DecisionMode
    thresholds?: Partial<Thresholds>
    log: DecisionLog
    riskPaths: readonly string[]
    monitorRate?: number
    random?: () => number
  }) {
    this.host = opts.host
    this.rules = opts.rules
    this.jev = opts.jev
    this.mode = opts.jev === undefined ? 'rules' : opts.mode
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds }
    this.log = opts.log
    this.riskPaths = opts.riskPaths
    this.monitorRate = opts.monitorRate ?? 0.1
    this.random = opts.random ?? Math.random
  }

  get activeMode(): DecisionMode {
    return this.mode
  }

  private async now(): Promise<string> {
    return iso(await this.host.now())
  }

  async classify(task: Task, ctx: RepoContext): Promise<Classification> {
    const rules = await this.rules.classify(task, ctx)
    if (this.mode === 'rules' || this.jev === undefined) return rules
    let jev: Classification | undefined
    let error: string | undefined
    try {
      jev = await this.jev.classify(task, ctx)
    } catch (err) {
      error = String(err instanceof Error ? err.message : err)
    }
    const used = this.mode === 'enforce' && jev ? this.merge(task, rules, jev, ctx) : rules
    await this.log.append({ kind: 'classify', at: await this.now(), taskId: task.id, mode: this.mode, rules, jev, error, used }).catch(() => undefined)
    if (jev && this.random() < this.monitorRate) {
      const second = await this.jev.classify(task, ctx).catch(() => undefined)
      if (second) await this.log.append({ kind: 'monitor', at: await this.now(), taskId: task.id, first: jev, second }).catch(() => undefined)
    }
    return used
  }

  /** Per decision: Jev where it is confident enough, the rules elsewhere; tier recomputed in code. */
  private merge(task: Task, rules: Classification, jev: Classification, ctx: RepoContext): Classification {
    const t = this.thresholds
    const conf = (k: string) => jev.confidence?.[k] ?? 0
    const executor = conf('executor') >= t.executor && ctx.available.includes(jev.executor) ? jev.executor : rules.executor
    const complexity = conf('complexity') >= t.complexity ? jev.complexity : rules.complexity
    const floor = riskFloor(task.files ?? [], this.riskPaths)
    const risk = Math.max(floor, conf('risk') >= t.risk ? jev.risk : rules.risk)
    const needsHuman = certainty(jev.needsHuman) >= t.needsHuman ? jev.needsHuman : rules.needsHuman
    // Risk >= 4 forces `secure` in code; otherwise Jev's template where it is confident, the rules' elsewhere.
    const template = risk >= 4 ? 'secure' : conf('template') >= t.template && jev.template ? jev.template : rules.template
    return {
      template,
      executor,
      tier: tierFor(complexity, risk),
      complexity,
      risk,
      // Files overlapping is a fact the code computes; Jev's opinion stays in the log.
      parallelizable: rules.parallelizable,
      needsHuman,
      source: 'jev',
      model: jev.model,
      confidence: jev.confidence,
    }
  }

  async isVerified(task: Task, evidence: Evidence): Promise<Verification> {
    const rules = await this.rules.isVerified(task, evidence)
    if (this.mode === 'rules' || this.jev === undefined) return rules
    let jev: Verification | undefined
    let error: string | undefined
    // Hard facts fail closed: Jev is not asked to overrule failed checks or an empty change.
    const isHardFail = rules.verified === 0
    if (!isHardFail) {
      try {
        jev = await this.jev.isVerified(task, evidence)
      } catch (err) {
        error = String(err instanceof Error ? err.message : err)
      }
    }
    const used = this.mode === 'enforce' && jev ? jev : rules
    await this.log.append({ kind: 'verify', at: await this.now(), taskId: task.id, attempt: task.attempts.length, mode: this.mode, rules, jev, error, used }).catch(() => undefined)
    return used
  }

  async label(task: Task): Promise<void> {
    await this.log.append({
      kind: 'label',
      at: await this.now(),
      taskId: task.id,
      finalStatus: task.status,
      attempts: task.attempts.length,
      cleanFirstTry: task.status === 'merged' && task.attempts.length === 1 && task.reviewedByMaestro !== true,
      reviewedByMaestro: task.reviewedByMaestro === true,
      tiers: task.attempts.map(a => a.tier),
      executors: task.attempts.map(a => a.executor),
    })
  }
}
