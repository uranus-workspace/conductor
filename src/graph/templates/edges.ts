// Routers the templates share. Each returns where to go and why; limits live in retryOr.
import { retryOr } from '../engine.ts'
import type { Cursor, EdgeTarget, NodeId, TaskState } from '../graph.types.ts'

/** Checks green (or none configured) → `next`; red → back to implement while the limits allow. */
export const afterCheck = (next: Cursor) => (s: TaskState): EdgeTarget =>
  s.outcome.status === 'fail'
    ? retryOr(s, 'implement', 'failed', `checks failed${s.outcome.reason ? `: ${s.outcome.reason.split('\n')[0]}` : ''}`)
    : { to: next, reason: s.outcome.status === 'skip' ? 'no checks configured' : 'checks passed', rule: 'checks' }

/** The reviewer's fail → back to implement; pass, unsure or no reviewer → `next` (the judge or a gate weighs it). */
export const afterReview = (next: Cursor, fallback: Cursor = 'needs_review') => (s: TaskState): EdgeTarget =>
  s.outcome.review === 'fail'
    ? retryOr(s, 'implement', fallback, `the reviewer failed it${s.outcome.reason ? `: ${s.outcome.reason.split('\n')[0]}` : ''}`)
    : { to: next, reason: s.outcome.status === 'skip' ? 'no independent reviewer available' : `review: ${s.outcome.review ?? 'pass'}`, rule: 'review' }

/** The judge's verified probability against the threshold. */
export const afterJudge = (next: Cursor) => (s: TaskState): EdgeTarget => {
  const p = s.outcome.verdict ?? 0
  return p >= s.verifyThreshold && s.outcome.status !== 'fail'
    ? { to: next, reason: `verified (p=${p.toFixed(2)})`, rule: 'verifyThreshold' }
    : { to: 'needs_review', reason: s.outcome.reason ?? `not verified enough (p=${p.toFixed(2)} < ${s.verifyThreshold})`, rule: 'verifyThreshold' }
}

/** Security findings → back to implement (the scanner said what to fix); none → `next`. */
export const afterSecurity = (next: Cursor) => (s: TaskState): EdgeTarget =>
  s.outcome.status === 'fail'
    ? retryOr(s, 'implement', 'needs_review', `security findings${s.outcome.reason ? `: ${s.outcome.reason.split('\n')[0]}` : ''}`)
    : { to: next, reason: s.outcome.status === 'skip' ? 'no security scanner configured' : 'no security findings', rule: 'security' }

/** Research never blocks: notes or not, the next node runs with what there is. */
export const afterResearch = (next: NodeId) => (s: TaskState): EdgeTarget =>
  ({ to: next, reason: s.outcome.status === 'ok' ? 'notes written' : `research ${s.outcome.status}: going on without notes`, rule: 'research' })
