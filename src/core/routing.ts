import { TIERS } from './constants.ts'
import type { ExecutorId, Tier } from './domain.types.ts'

/** Doc §7.1: the tier is code's call, from the two scores. */
export function tierFor(complexity: number, risk: number): Tier {
  if (complexity >= 4 || risk >= 4) return 'strong'
  if (complexity <= 2 && risk <= 2) return 'cheap'
  return 'standard'
}

/** Each retry climbs one tier, capped at `strong`. */
export function escalate(tier: Tier, steps: number): Tier {
  const at = TIERS.indexOf(tier)
  return TIERS[Math.min(TIERS.length - 1, at + steps)] ?? 'strong'
}

/** The deterministic risk floor: a model may raise risk, never lower it below this. */
export function riskFloor(files: readonly string[], riskPaths: readonly string[]): number {
  const patterns = riskPaths.map(p => new RegExp(p, 'i'))
  return files.some(f => patterns.some(p => p.test(f))) ? 4 : 1
}

export const clampScore = (n: number): number => Math.max(1, Math.min(5, Math.round(n)))

/** Falls back along a fixed preference when the routed executor is unavailable. */
export function pickAvailable(wanted: ExecutorId, available: readonly ExecutorId[]): ExecutorId | undefined {
  if (available.includes(wanted)) return wanted
  const order: ExecutorId[] = ['claude', 'codex', 'antigravity', 'opencode', 'cursor']
  return order.find(id => available.includes(id))
}

/** Files two tasks both declare. */
export function overlap(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b)
  return a.filter(f => set.has(f))
}
