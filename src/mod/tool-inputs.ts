// Tool inputs arrive as model-written JSON: each is checked here, once, into its type.
import { isWorker } from '../core/config.ts'
import type { PlanInput, WorkerId } from '../core/domain.types.ts'
import type { JsonObject } from '../core/json.types.ts'
import type {
  ApproveToolInput, AskOpenRouterToolInput, DispatchToolInput, PlanToolInput, RejectToolInput, StatusToolInput,
} from './tool-inputs.types.ts'

export class ToolInputError extends Error {}

const fields = (input: unknown): JsonObject => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ToolInputError('the input must be an object')
  return input as JsonObject
}

const text = (o: JsonObject, key: string): string => {
  const v = o[key]
  if (typeof v !== 'string' || v.trim() === '') throw new ToolInputError(`${key} must be a non-empty string`)
  return v
}

const optionalText = (o: JsonObject, key: string): string | undefined => {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`${key} must be a string`)
  return v
}

const texts = (o: JsonObject, key: string, required: boolean): string[] | undefined => {
  const v = o[key]
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${key} must be a list of strings`)
    return undefined
  }
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new ToolInputError(`${key} must be a list of strings`)
  return v as string[]
}

const worker = (o: JsonObject, key: string): WorkerId | undefined => {
  const v = optionalText(o, key)
  if (v === undefined) return undefined
  if (!isWorker(v)) throw new ToolInputError(`${key} must name a worker`)
  return v
}

function planTask(input: unknown, index: number): PlanInput {
  const o = fields(input)
  try {
    return {
      key: text(o, 'key'),
      title: text(o, 'title'),
      description: text(o, 'description'),
      acceptance: texts(o, 'acceptance', true) ?? [],
      files: texts(o, 'files', false),
      dependsOn: texts(o, 'dependsOn', false),
      labels: texts(o, 'labels', false),
      client: optionalText(o, 'client'),
      designRefs: texts(o, 'designRefs', false),
    }
  } catch (err) {
    throw new ToolInputError(`tasks[${index}]: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function parsePlanInput(input: unknown): PlanToolInput {
  const o = fields(input)
  if (!Array.isArray(o.tasks)) throw new ToolInputError('tasks must be a list')
  return { runId: optionalText(o, 'runId'), goal: optionalText(o, 'goal'), tasks: o.tasks.map(planTask) }
}

export function parseStatusInput(input: unknown): StatusToolInput {
  return { runId: optionalText(fields(input), 'runId') }
}

export function parseApproveInput(input: unknown): ApproveToolInput {
  const o = fields(input)
  return { taskId: text(o, 'taskId'), note: optionalText(o, 'note') }
}

export function parseRejectInput(input: unknown): RejectToolInput {
  const o = fields(input)
  return { taskId: text(o, 'taskId'), reason: text(o, 'reason'), retry: o.retry === true, executor: worker(o, 'executor') }
}

export function parseDispatchInput(input: unknown): DispatchToolInput {
  const o = fields(input)
  return { taskId: text(o, 'taskId'), executor: worker(o, 'executor') }
}

export function parseAskOpenRouterInput(input: unknown): AskOpenRouterToolInput {
  const o = fields(input)
  const maxTokens = o.maxTokens
  if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new ToolInputError('maxTokens must be a positive integer')
  }
  return { prompt: text(o, 'prompt'), model: optionalText(o, 'model'), system: optionalText(o, 'system'), maxTokens }
}
