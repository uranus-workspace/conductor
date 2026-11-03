import type { Host } from '../../core/host.types.ts'
import { redactDeep } from '../../core/redact.ts'
import { clampScore, pickAvailable, riskFloor, tierFor } from '../../core/routing.ts'
import type { Classification, Evidence, ExecutorId, RepoContext, Task } from '../../core/domain.types.ts'
import type { DecisionModel, Verification } from './decision.types.ts'
import type { JevSettings } from '../../core/config.types.ts'
import type { JevAnswer, JevQuestion, JevRequest, JevResponse } from './jev.types.ts'
import { isWorker } from '../../core/config.ts'
import { isTemplateId, TEMPLATE_IDS } from '../../graph/templates/index.ts'
import type { TemplateId } from '../../graph/graph.types.ts'

// Jev through OpenRouter's System One API: one state, named questions of type
// noul (yes-probability), choice (criteria: name -> description) or score
// (criteria: ordered levels, answered 0-based with a fractional mean).

export class JevError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseAnswer(v: unknown): JevAnswer | undefined {
  if (!isRecord(v)) return undefined
  const confidence = typeof v.confidence === 'number' ? v.confidence : null
  const probabilities = isRecord(v.probabilities) ? (v.probabilities as Record<string, number>) : undefined
  if (v.type === 'noul' && typeof v.noul === 'number') return { type: 'noul', noul: v.noul }
  if (v.type === 'choice' && typeof v.choice === 'string') return { type: 'choice', choice: v.choice, confidence, probabilities }
  if (v.type === 'score' && typeof v.score === 'number') return { type: 'score', score: v.score, confidence, probabilities }
  return undefined
}

/** Checks a reply at the boundary: answers it cannot read are left out, never guessed. */
export function parseJevResponse(text: string): JevResponse {
  const body: unknown = JSON.parse(text)
  if (!isRecord(body) || !isRecord(body.answers)) throw new JevError('no answers in the reply')
  const answers: Record<string, JevAnswer> = {}
  for (const [name, raw] of Object.entries(body.answers)) {
    const answer = parseAnswer(raw)
    if (answer) answers[name] = answer
  }
  const usage = isRecord(body.usage)
    ? {
        input_tokens: Number(body.usage.input_tokens ?? 0),
        output_tokens: Number(body.usage.output_tokens ?? 0),
        cost: typeof body.usage.cost === 'number' ? body.usage.cost : undefined,
      }
    : undefined
  return { model: typeof body.model === 'string' ? body.model : 'unknown', answers, usage }
}

export class JevClient {
  private readonly host: Host
  private readonly config: JevSettings

  constructor(host: Host, config: JevSettings) {
    this.host = host
    this.config = config
  }

  /** All questions about one state in one request (doc §7: batch). Secrets never leave. */
  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse> {
    const key = await this.host.openrouterKey()
    if (!key) throw new JevError('OPENROUTER_API_KEY is not set')
    const body: JevRequest = { model: this.config.model, state: redactDeep(state), questions }
    const request = this.host.fetch(`${this.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'Conductor' },
      body: JSON.stringify(body),
    })
    // Judgments fail open: a slow Jev is no Jev.
    const timeout = this.host.sleep(this.config.timeoutMs).then(() => {
      throw new JevError(`timeout after ${this.config.timeoutMs} ms`)
    })
    const res = await Promise.race([request, timeout])
    if (!res.ok) throw new JevError(`HTTP ${res.status}: ${res.text.slice(0, 200)}`)
    return parseJevResponse(res.text)
  }
}

/** Fisher–Yates over a copy; Jev leans toward the first option, so every call reorders. */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

const WORKER_CRITERIA: Record<ExecutorId, string> = {
  claude: 'Ambiguous, cross-cutting work that needs judgment or design decisions',
  codex: 'Well-specified, self-contained logic with clear acceptance criteria',
  cursor: 'Mechanical, repetitive edits across many files',
  opencode: 'Simple, low-risk boilerplate',
  antigravity: 'Well-specified feature work on the frontend or a single module',
  openrouter: 'Writing the text content of one file (docs, fixtures), no code changes',
}

const TEMPLATE_CRITERIA: Record<TemplateId, string> = {
  solo: 'A small, low-risk task with one obvious change',
  feature: 'New functionality with clear acceptance criteria',
  bugfix: 'A bug with a known symptom that should be reproduced first',
  refactor: 'The same mechanical change across many files',
  secure: 'Touches authentication, payments, personal data, tax rules or migrations',
  spike: 'An investigation or proof of concept with no code to merge',
}

const COMPLEXITY = [
  'Trivial: a one-line or purely textual change',
  'Small: a local change in one place with an obvious approach',
  'Moderate: several related changes, the approach is clear',
  'Hard: many interacting parts or a non-obvious approach',
  'Requires design decisions before it can be implemented',
]

const RISK = [
  'Cosmetic: a mistake is only visible, nothing breaks',
  'Low: a mistake breaks a minor feature that tests would catch',
  'Moderate: a mistake breaks a user-facing feature',
  'High: a mistake corrupts data or breaks a core flow',
  'Critical: authentication, payments, data loss or tax rules',
]

/** A Score answer (0-based mean over n levels) as the 1..5 scale the Conductor uses. */
export const fromScore = (a: JevAnswer | undefined): number | undefined =>
  a?.type === 'score' ? clampScore(a.score + 1) : undefined

export const noul = (a: JevAnswer | undefined): number | undefined => (a?.type === 'noul' ? a.noul : undefined)

/** Jev as a DecisionModel (doc §7). Asks; never writes. Risk is floored in code. */
export class JevDecisionModel implements DecisionModel {
  private readonly client: JevClient
  private readonly riskPaths: readonly string[]
  private readonly random: () => number

  constructor(client: JevClient, riskPaths: readonly string[], random: () => number = Math.random) {
    this.client = client
    this.riskPaths = riskPaths
    this.random = random
  }

  async classify(task: Task, ctx: RepoContext): Promise<Classification> {
    const workers: readonly ExecutorId[] = ctx.available.length ? ctx.available : ['claude']
    const criteria: Record<string, string> = {}
    for (const id of shuffle(workers, this.random)) criteria[id] = WORKER_CRITERIA[id]
    criteria.other = 'None of the workers above fits this task'
    const templateCriteria: Record<string, string> = {}
    for (const id of shuffle(TEMPLATE_IDS, this.random)) templateCriteria[id] = TEMPLATE_CRITERIA[id]
    templateCriteria.other = 'None of the workflows above fits this task'

    const res = await this.client.ask(
      {
        task: { title: task.title, description: task.description, acceptance_criteria: task.acceptance, files: task.files ?? [] },
        files_touched_by_other_open_tasks: ctx.openTaskFiles,
      },
      {
        executor: { type: 'choice', instructions: 'Which worker should implement this task?', criteria },
        complexity: { type: 'score', instructions: 'How complex is this task to implement correctly?', criteria: COMPLEXITY },
        risk: { type: 'score', instructions: 'How much damage could a wrong implementation cause?', criteria: RISK },
        parallelizable: { type: 'noul', instructions: 'Can this task be done without touching files that other open tasks touch?' },
        needsHuman: { type: 'noul', instructions: 'Does this task require a decision that only a human can make?' },
        template: { type: 'choice', instructions: 'Which workflow fits this task?', criteria: templateCriteria },
      },
    )
    const a = res.answers
    const chosen = a.executor?.type === 'choice' ? a.executor.choice : 'other'
    const named = isWorker(chosen) && workers.includes(chosen) ? chosen : undefined
    const executor: ExecutorId = named ?? pickAvailable('claude', workers) ?? 'claude'
    const complexity = fromScore(a.complexity) ?? 3
    // Jev may raise risk above the deterministic floor, never lower it.
    const risk = Math.max(riskFloor(task.files ?? [], this.riskPaths), fromScore(a.risk) ?? 3)
    const conf = (k: string) => {
      const x = a[k]
      return x && x.type !== 'noul' ? x.confidence ?? 0 : 0
    }
    const picked = a.template?.type === 'choice' ? a.template.choice : 'other'
    // Risk >= 4 is always `secure`, whatever Jev says; `other` or an unknown answer falls back to `solo`.
    const template: TemplateId = risk >= 4 ? 'secure' : isTemplateId(picked) ? picked : 'solo'
    return {
      template,
      executor,
      tier: tierFor(complexity, risk),
      complexity,
      risk,
      parallelizable: noul(a.parallelizable) ?? 0.5,
      needsHuman: noul(a.needsHuman) ?? 0,
      source: 'jev',
      model: res.model,
      confidence: { executor: conf('executor'), complexity: conf('complexity'), risk: conf('risk'), template: conf('template') },
    }
  }

  async isVerified(task: Task, evidence: Evidence): Promise<Verification> {
    const res = await this.client.ask(
      {
        task: { title: task.title, description: task.description, acceptance_criteria: task.acceptance, declared_files: task.files ?? [] },
        change: { diff_summary: evidence.diffStat ?? '', changed_files: evidence.changedFiles },
        checks: evidence.checksPassed === null ? 'no deterministic checks configured' : evidence.checksPassed ? 'passed' : 'failed',
        checks_output_tail: evidence.checksOutput ?? '',
        reviewer_verdict: evidence.reviewVerdict ?? 'no reviewer',
      },
      {
        verified: { type: 'noul', instructions: 'Given the acceptance criteria, the diff summary and the test output, is the task fully done?' },
        scopeCreep: { type: 'noul', instructions: 'Did the change modify files unrelated to the task?' },
      },
    )
    return {
      verified: noul(res.answers.verified) ?? 0,
      scopeCreep: noul(res.answers.scopeCreep),
      source: 'jev',
      model: res.model,
    }
  }
}
