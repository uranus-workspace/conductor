import { clampScore, overlap, pickAvailable, riskFloor, tierFor } from '../../core/routing.ts'
import type { Classification, Evidence, ExecutorId, RepoContext, Task } from '../../core/domain.types.ts'
import type { DecisionModel, Verification } from './decision.types.ts'
import { isWorker } from '../../core/config.ts'
import { isTemplateId } from '../../graph/templates/index.ts'
import type { TemplateId } from '../../graph/graph.types.ts'

const HARD = /\b(architect|design|refactor|migrat|cross-cutting|concurren|security|performance|protocol)/i
const EASY = /\b(typo|rename|docs?|readme|comment|bump|format|lint|copy change)/i
const MECHANICAL = /\b(rename|replace|move|bulk|across (all|every)|codemod|update imports)/i
const SPIKE = /\b(spike|investigate|investigation|research|proof of concept|poc|evaluate options|explore)\b/i
const BUG = /\b(bug|fix|regression|crash|error|broken|fails?|exception)\b/i
const HUMAN = /\b(decide|decision|choose between|which (option|approach)|ask the (user|client)|product call)\b|\?\s*$/i

/**
 * The template, by rule (§7.1): risk >= 4 is always `secure`; a `template:<id>` label wins
 * otherwise; then the wording; in doubt, `solo`.
 */
export function templateFor(task: Task, text: string, complexity: number, risk: number, fileCount: number): TemplateId {
  if (risk >= 4) return 'secure'
  const label = task.labels?.find(l => l.startsWith('template:'))?.slice('template:'.length)
  if (label !== undefined && isTemplateId(label)) return label
  if (SPIKE.test(text)) return 'spike'
  if (BUG.test(text)) return 'bugfix'
  if (MECHANICAL.test(text) && fileCount >= 5) return 'refactor'
  if (complexity <= 2 && risk <= 2) return 'solo'
  return 'feature'
}

/**
 * Deterministic fallback for every enumerable decision (doc §2, §7.3 step 1).
 * Cheap heuristics on the evidence the plan carries; never calls a model.
 */
export class RuleDecisionModel implements DecisionModel {
  private readonly riskPaths: readonly string[]

  constructor(riskPaths: readonly string[]) {
    this.riskPaths = riskPaths
  }

  async classify(task: Task, ctx: RepoContext): Promise<Classification> {
    const text = `${task.title}\n${task.description}`
    const files = task.files ?? []

    let complexity = 2 + (task.acceptance.length > 3 ? 1 : 0) + (files.length > 5 ? 1 : 0)
    if (HARD.test(text)) complexity += 2
    if (EASY.test(text)) complexity -= 1
    complexity = clampScore(complexity)

    const floor = riskFloor(files, this.riskPaths)
    const risk = clampScore(Math.max(floor, complexity >= 4 ? 3 : 2))

    const label = task.labels?.find(l => l.startsWith('executor:'))?.slice('executor:'.length)
    const forced = label !== undefined && isWorker(label) ? label : undefined
    let wanted: ExecutorId
    if (forced !== undefined) wanted = forced
    else if (complexity >= 4 || risk >= 4) wanted = 'claude'
    else if (MECHANICAL.test(text) && files.length >= 5) wanted = 'cursor'
    else if (complexity <= 2 && risk <= 2) wanted = 'opencode'
    else wanted = 'codex'
    const executor = pickAvailable(wanted, ctx.available) ?? 'claude'

    const shared = overlap(files, ctx.openTaskFiles)
    return {
      template: templateFor(task, text, complexity, risk, files.length),
      executor,
      tier: tierFor(complexity, risk),
      complexity,
      risk,
      parallelizable: files.length === 0 ? 0.5 : shared.length === 0 ? 1 : 0,
      needsHuman: HUMAN.test(text) ? 0.7 : 0.05,
      source: 'rules',
    }
  }

  async isVerified(task: Task, evidence: Evidence): Promise<Verification> {
    return { verified: this.probability(task, evidence), source: 'rules' }
  }

  private probability(task: Task, evidence: Evidence): number {
    if (evidence.checksPassed === false || evidence.reviewVerdict === 'fail') return 0
    if (evidence.changedFiles.length === 0) return 0
    // Green deterministic checks are enough for ordinary risk; no checks needs a reviewer's pass.
    let p = evidence.checksPassed === true ? 0.8 : 0.4
    if (evidence.reviewVerdict === 'pass') p = Math.max(p + 0.15, 0.8)
    if (evidence.reviewVerdict === 'review') p = Math.min(p, 0.5)
    // High risk is never done on checks alone: it takes the reviewer's pass or the maestro.
    if ((task.classification?.risk ?? 1) >= 4 && evidence.reviewVerdict !== 'pass') p = Math.min(p, 0.79)
    return Math.min(1, p)
  }
}

/**
 * Share of changed files the task did not declare. Computed in code (doc §7:
 * no counting asked of a model). With no declared files there is no scope to creep.
 */
export function scopeCreep(task: Task, changedFiles: readonly string[]): number {
  const declared = task.files ?? []
  if (declared.length === 0 || changedFiles.length === 0) return 0
  const inScope = (f: string) => declared.some(d => f === d || f.startsWith(d.endsWith('/') ? d : `${d}/`))
  return changedFiles.filter(f => !inScope(f)).length / changedFiles.length
}
