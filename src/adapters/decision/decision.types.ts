import type { DecisionMode } from '../../core/config.types.ts'
import type { Classification, Evidence, RepoContext, Task } from '../../core/domain.types.ts'

export interface Verification {
  /** Probability 0..1 that the task is fully done. */
  verified: number
  /** Probability 0..1 that the change went outside the task (Jev); code measures its own. */
  scopeCreep?: number
  source: 'jev' | 'rules'
  model?: string
}

export interface DecisionModel {
  classify(task: Task, ctx: RepoContext): Promise<Classification>
  isVerified(task: Task, evidence: Evidence): Promise<Verification>
  /** Called once a task reaches a final state: the outcome that labels earlier decisions (Jev rollout). */
  label?(task: Task): Promise<void>
}

/** Minimum certainty before an enforced Jev answer replaces the rules' (doc §7.3 step 3). */
export interface Thresholds {
  executor: number      // choice confidence
  complexity: number    // score confidence
  risk: number          // score confidence
  needsHuman: number    // how far the noul must be from 0.5, as 0..1
  template: number      // choice confidence
}

export type DecisionRecord =
  | { kind: 'classify'; at: string; taskId: string; mode: DecisionMode; rules: Classification; jev?: Classification; error?: string; used: Classification }
  | { kind: 'verify'; at: string; taskId: string; attempt: number; mode: DecisionMode; rules: Verification; jev?: Verification; error?: string; used: Verification }
  | { kind: 'monitor'; at: string; taskId: string; first: Classification; second: Classification }

export interface LabelRecord {
  kind: 'label'
  at: string
  taskId: string
  finalStatus: Task['status']
  attempts: number
  /** Merged on the first attempt with no maestro review: the decisions were right. */
  cleanFirstTry: boolean
  reviewedByMaestro: boolean
  tiers: string[]
  executors: string[]
}

export interface ThresholdSuggestion {
  /** The verified threshold that best separates labelled outcomes; undefined below the sample minimum. */
  verified?: { threshold: number; accuracy: number; rulesAccuracy: number; samples: number }
}

export interface JevReport {
  classify: number
  verify: number
  labels: number
  jevErrors: number
  agreement: { executor: number; tier: number; needsHuman: number } | undefined
  underTiered: { rules: number; jev: number } | undefined
  consistency: { executor: number; complexityWithin1: number; samples: number } | undefined
  suggestion: ThresholdSuggestion
  models: string[]
}
