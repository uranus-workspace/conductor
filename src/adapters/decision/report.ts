import type { DecisionRecord, JevReport, LabelRecord, ThresholdSuggestion } from './decision.types.ts'

const MIN_SAMPLES = 10
const share = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0)

/**
 * Labels and thresholds (doc §7.3 steps 2–3, 5). All counting is code's job.
 * A verify decision is labelled by its task's outcome: right when the task
 * ended merged without the maestro sending it back, wrong when it failed or
 * the maestro had to look. A tier was too low when the task needed a retry.
 */
export function buildReport(records: Array<DecisionRecord | LabelRecord>): JevReport {
  const classify = records.filter((r): r is Extract<DecisionRecord, { kind: 'classify' }> => r.kind === 'classify')
  const verify = records.filter((r): r is Extract<DecisionRecord, { kind: 'verify' }> => r.kind === 'verify')
  const monitor = records.filter((r): r is Extract<DecisionRecord, { kind: 'monitor' }> => r.kind === 'monitor')
  const labels = new Map(records.filter((r): r is LabelRecord => r.kind === 'label').map(l => [l.taskId, l]))

  const both = classify.filter(r => r.jev !== undefined)
  const agreement = both.length
    ? {
        executor: share(both.map(r => r.jev?.executor === r.rules.executor)),
        tier: share(both.map(r => r.jev?.tier === r.rules.tier)),
        needsHuman: share(both.map(r => (r.jev?.needsHuman ?? 0) >= 0.5 === r.rules.needsHuman >= 0.5)),
      }
    : undefined

  const labelled = both.filter(r => labels.has(r.taskId))
  const tierRank = { cheap: 0, standard: 1, strong: 2 } as const
  const needed = (taskId: string) => {
    const l = labels.get(taskId)
    // The tier that finally worked, when it merged after retries.
    return l && l.finalStatus === 'merged' ? tierRank[(l.tiers.at(-1) ?? 'standard') as keyof typeof tierRank] : undefined
  }
  const under = (tier: string, taskId: string) => {
    const n = needed(taskId)
    return n !== undefined && tierRank[tier as keyof typeof tierRank] < n
  }
  const underTiered = labelled.length
    ? { rules: share(labelled.map(r => under(r.rules.tier, r.taskId))), jev: share(labelled.map(r => under(r.jev?.tier ?? 'standard', r.taskId))) }
    : undefined

  const consistency = monitor.length
    ? {
        executor: share(monitor.map(m => m.first.executor === m.second.executor)),
        complexityWithin1: share(monitor.map(m => Math.abs(m.first.complexity - m.second.complexity) <= 1)),
        samples: monitor.length,
      }
    : undefined

  // Verified threshold sweep over decisions whose task has an outcome.
  const points = verify.flatMap(r => {
    const l = labels.get(r.taskId)
    if (r.jev === undefined || l === undefined) return []
    return [{ jev: r.jev.verified, rules: r.rules.verified, truth: l.finalStatus === 'merged' && !l.reviewedByMaestro }]
  })
  const suggestion: ThresholdSuggestion = {}
  if (points.length >= MIN_SAMPLES) {
    let best = { threshold: 0.8, accuracy: -1 }
    // Integer steps: 0.05 added in floating point drifts past the values it should land on.
    for (let k = 50; k <= 95; k += 5) {
      const t = k / 100
      const acc = share(points.map(p => p.jev >= t === p.truth))
      if (acc > best.accuracy) best = { threshold: t, accuracy: acc }
    }
    suggestion.verified = { ...best, rulesAccuracy: share(points.map(p => p.rules >= 0.8 === p.truth)), samples: points.length }
  }

  const models = [...new Set([...classify.map(r => r.jev?.model), ...verify.map(r => r.jev?.model)].filter((m): m is string => Boolean(m)))]
  return {
    classify: classify.length,
    verify: verify.length,
    labels: labels.size,
    jevErrors: [...classify, ...verify].filter(r => r.error !== undefined).length,
    agreement,
    underTiered,
    consistency,
    suggestion,
    models,
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`

export function reportText(r: JevReport, mode: string): string {
  const lines = [
    `Jev: ${mode} mode · ${r.classify} classifications, ${r.verify} verifications, ${r.labels} labelled tasks, ${r.jevErrors} Jev failures (fell back to the rules)`,
    `models that answered: ${r.models.join(', ') || '(none yet)'}`,
  ]
  if (r.agreement) lines.push(`Jev × rules agreement: executor ${pct(r.agreement.executor)}, tier ${pct(r.agreement.tier)}, needsHuman ${pct(r.agreement.needsHuman)}`)
  if (r.underTiered) lines.push(`tier below what was needed (took a retry): rules ${pct(r.underTiered.rules)}, Jev ${pct(r.underTiered.jev)}`)
  if (r.consistency) lines.push(`consistency (asked twice, options reshuffled, n=${r.consistency.samples}): executor ${pct(r.consistency.executor)}, complexity within 1 ${pct(r.consistency.complexityWithin1)}`)
  const v = r.suggestion.verified
  lines.push(v
    ? `suggested verified threshold: ${v.threshold} (accuracy ${pct(v.accuracy)} vs rules ${pct(v.rulesAccuracy)}, n=${v.samples}) → "verifyThreshold" in .conductor/config.json`
    : `verified threshold: not enough samples yet (at least ${MIN_SAMPLES} labelled verifications)`)
  return lines.join('\n')
}
