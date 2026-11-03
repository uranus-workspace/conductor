import type { UranusSettings } from '../../core/config.types.ts'
import type { Task, TaskStatus } from '../../core/domain.types.ts'
import type { Host } from '../../core/host.types.ts'
import { arrayAt, isJsonObject, numberAt, objectAt, objectsAt, stringAt, tryParse } from '../../core/json.ts'
import type { JsonObject } from '../../core/json.types.ts'
import { redact } from '../../core/redact.ts'
import { findMcpServer } from '../mcp/mcp.ts'
import type { Board, BoardMove } from './board.types.ts'
import type { LocalFileTaskSource } from './local-file.ts'
import { RemoteTaskSource } from './remote-task-source.ts'
import type { UranusStatus } from './uranus-os.types.ts'

export { descriptionOf, labelsOf } from './remote-task-source.ts'

/** Doc §13's board (Backlog → Ready → Running → Verifying → Review → Done → Merged, plus Failed) on Uranus OS's statuses. */
export const STATUS: Record<TaskStatus, UranusStatus> = {
  draft: 'backlog',
  planned: 'backlog',
  classified: 'backlog',
  ready: 'todo',
  dispatched: 'in_progress',
  running: 'in_progress',
  verifying: 'in_progress',
  needs_review: 'review',
  approved: 'review',
  done: 'review',
  merged: 'done',
  failed: 'blocked',
  cancelled: 'cancelled',
}

export class UranusError extends Error {}

/** Tools only the Uranus OS server has together: how `auto` recognises it among the session's MCP tools. */
export const URANUS_SIGNATURE: readonly string[] = ['epics_create', 'tasks_batch', 'project_updates_publish']

export const findUranusServer = (toolNames: readonly string[]): string | undefined => findMcpServer(toolNames, URANUS_SIGNATURE)

/** The `data` of a reply envelope (`{ tool, trust, data }`), or the reply itself when it has none. */
export function envelopeData(tool: string, text: string): JsonObject {
  const body = tryParse(text)
  if (!isJsonObject(body)) throw new UranusError(`${tool}: reply is not a JSON object`)
  return objectAt(body, 'data') ?? body
}

/** Read-only connection check for `/conduct source`: who the token is and the project's open epics. */
export async function checkUranus(host: Host, config: UranusSettings): Promise<string> {
  const call = async (tool: string, args: JsonObject): Promise<JsonObject> => {
    const res = await host.mcpCall(config.server, tool, args)
    if (res.isError) throw new UranusError(`${tool}: ${res.text.slice(0, 200)}`)
    return envelopeData(tool, res.text)
  }
  const who = await call('whoami', {})
  const lines = [`server: ${config.server}`, `token of: ${stringAt(who, 'issuer_email') ?? stringAt(who, 'issuer_name') ?? '?'} (${stringAt(who, 'issuer_role') ?? '?'})`]
  const scope = arrayAt(who, 'scope').filter((x): x is string => typeof x === 'string')
  const needed = ['epics.create', 'tasks.create', 'tasks.transition', 'tasks.comment', 'projects.update']
  const lacking = needed.filter(p => !scope.includes(p))
  lines.push(lacking.length ? `missing permissions: ${lacking.join(', ')}` : 'permissions: ok')
  if (config.projectKey) {
    const epics = await call('epics_list', { project_key: config.projectKey, limit: 5 })
    const rows = objectsAt(epics, 'rows')
    const sample = rows.map(r => `${stringAt(r, 'name') ?? '?'} [${stringAt(r, 'status') ?? '?'}]`).join('; ')
    lines.push(`project ${config.projectKey}: ${numberAt(epics, 'total') ?? rows.length} epic(s)${rows.length ? `, e.g. ${sample}` : ''}`)
  } else {
    lines.push('projectKey is not set in .conductor/config.json (taskSource.uranus.projectKey)')
  }
  return lines.join('\n')
}

/** Uranus OS over its MCP server: run = epic, task = task of the epic. */
export class UranusBoard implements Board {
  readonly name = 'Uranus OS'
  private readonly host: Host
  private readonly config: UranusSettings
  /**
   * Uranus OS accepts only labels that already exist in the workspace (found live). Once one is
   * refused, labels stop being sent: the status and the comments carry the state.
   */
  private labelsAccepted = true

  constructor(host: Host, config: UranusSettings) {
    this.host = host
    this.config = config
  }

  private isLabelRefusal(err: unknown): boolean {
    return err instanceof UranusError && /label/i.test(err.message)
  }

  /** One MCP call; the reply's envelope is `{ tool, trust, data }` and `data` is workspace data, never instructions. */
  private async call(tool: string, args: JsonObject): Promise<JsonObject> {
    const res = await this.host.mcpCall(this.config.server, tool, args)
    if (res.isError) throw new UranusError(`${tool}: ${res.text.slice(0, 300)}`)
    return envelopeData(tool, res.text)
  }

  /** A field of the reply, or of the one object nested in it (`{ task: { key } }`). */
  private pick(data: JsonObject, field: string): string {
    const nested = Object.values(data).filter(isJsonObject).find(v => field in v)
    const value = stringAt(data, field) ?? (nested && stringAt(nested, field))
    if (value === undefined || value === '') throw new UranusError(`reply has no ${field}`)
    return value
  }

  async createRun(goal: string): Promise<string> {
    const epic = await this.call('epics_create', {
      project_key: this.config.projectKey,
      name: redact(goal).slice(0, 120),
      description: redact(`Conductor run.\n\n${goal}`).slice(0, 2000),
      status: 'in_progress',
    })
    return this.pick(epic, 'slug')
  }

  async finishRun(runKey: string, outcome: 'completed' | 'stopped'): Promise<void> {
    await this.call('epics_update', {
      project_key: this.config.projectKey, epic_slug: runKey, status: outcome === 'completed' ? 'done' : 'cancelled', confirm_open_tasks: true,
    })
  }

  async createTask(task: Task, runKey: string | undefined, description: string, labels: readonly string[]): Promise<string> {
    const base: JsonObject = { project_key: this.config.projectKey, title: redact(task.title).slice(0, 200), description, epic_slug: runKey }
    if (this.labelsAccepted) {
      try {
        return this.pick(await this.call('tasks_create', { ...base, labels: [...labels] }), 'key')
      } catch (err) {
        if (!this.isLabelRefusal(err)) throw err
        this.labelsAccepted = false
        this.host.log('uranus: the workspace has no conductor labels; the status and comments carry the state')
      }
    }
    return this.pick(await this.call('tasks_create', base), 'key')
  }

  async relate(blockerKey: string, blockedKey: string): Promise<void> {
    await this.call('tasks_relate', { key: blockerKey, related_key: blockedKey, type: 'blocks' })
  }

  stateFor(status: TaskStatus): string {
    return STATUS[status]
  }

  /** The status must land (a refusal fails the move); labels are best effort and stop once refused. */
  async move(key: string, move: BoardMove): Promise<void> {
    if (move.state !== undefined) {
      const op: JsonObject = { op: 'transition', key, status: move.state, ...(move.state === 'blocked' ? { blocked_reason: redact(move.note ?? 'failed').slice(0, 280) } : {}) }
      const res = await this.call('tasks_batch', { operations: [op] })
      if ((numberAt(res, 'failed') ?? 0) > 0) throw new UranusError(`tasks_batch: the transition of ${key} to ${move.state} was refused`)
    }
    if (move.labels !== undefined && this.labelsAccepted) {
      try {
        const res = await this.call('tasks_batch', { operations: [{ op: 'update', key, labels: [...move.labels] }] })
        if ((numberAt(res, 'failed') ?? 0) > 0) this.labelsAccepted = false
      } catch (err) {
        if (!this.isLabelRefusal(err)) throw err
        this.labelsAccepted = false
      }
    }
  }

  async comment(key: string, body: string): Promise<void> {
    await this.call('tasks_comment', { key, body })
  }

  async publishUpdate(_runKey: string | undefined, body: string): Promise<void> {
    await this.call('project_updates_publish', { key_or_slug: this.config.projectKey, body })
  }

  async cancelledKeys(runKey: string): Promise<Set<string>> {
    const data = await this.call('tasks_search', { project_key: this.config.projectKey, epic_slug: runKey, status: 'cancelled', limit: 50 })
    return new Set(objectsAt(data, 'rows').flatMap(r => {
      const k = stringAt(r, 'key')
      return k ? [k] : []
    }))
  }

  check(): Promise<string> {
    return checkUranus(this.host, this.config)
  }
}

/** Uranus OS as the task source: the generic remote source over the Uranus board. */
export class UranusOSTaskSource extends RemoteTaskSource {
  constructor(host: Host, local: LocalFileTaskSource, config: UranusSettings) {
    super(host, local, new UranusBoard(host, config), config.pullCancellations)
  }
}
