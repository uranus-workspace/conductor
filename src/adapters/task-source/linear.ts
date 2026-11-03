import type { LinearSettings } from '../../core/config.types.ts'
import type { Task, TaskStatus } from '../../core/domain.types.ts'
import type { Host } from '../../core/host.types.ts'
import { objectsAt, stringAt } from '../../core/json.ts'
import type { JsonObject } from '../../core/json.types.ts'
import { redact } from '../../core/redact.ts'
import { findMcpServer, findString, replyObject } from '../mcp/mcp.ts'
import type { Board, BoardMove } from './board.types.ts'
import type { LocalFileTaskSource } from './local-file.ts'
import { RemoteTaskSource } from './remote-task-source.ts'

export class LinearError extends Error {}

/** Linear's MCP tools: the current upsert ones, or the older create/update ones. */
export const LINEAR_SIGNATURES: readonly (readonly string[])[] = [
  ['save_issue', 'list_issue_statuses', 'list_teams'],
  ['create_issue', 'update_issue', 'list_teams'],
]

export const findLinearServer = (toolNames: readonly string[]): string | undefined =>
  LINEAR_SIGNATURES.map(sig => findMcpServer(toolNames, sig)).find(s => s !== undefined)

/**
 * Linear over its MCP server: run = project, task = issue in it. The server's current
 * tools upsert (`save_issue`: no id creates, an id updates); an older server's
 * create_/update_ tools are used where the session lists them. Labels must exist in
 * Linear: an issue whose labels are refused is written without them.
 */
export class LinearBoard implements Board {
  readonly name = 'Linear'
  private readonly host: Host
  private readonly config: LinearSettings
  private readonly direct: ReadonlySet<string>

  /** `direct`: the tools the session lists for this server. */
  constructor(host: Host, config: LinearSettings, direct: ReadonlySet<string>) {
    this.host = host
    this.config = config
    this.direct = direct
  }

  private get upserts(): boolean {
    return this.direct.size === 0 || this.direct.has('save_issue')
  }

  private async call(tool: string, args: JsonObject): Promise<JsonObject> {
    const res = await this.host.mcpCall(this.config.server, tool, args)
    if (res.isError) throw new LinearError(`${tool}: ${res.text.slice(0, 300)}`)
    return replyObject(res.text)
  }

  private async saveIssue(args: JsonObject): Promise<JsonObject> {
    if (this.upserts) return this.call('save_issue', args)
    return this.call(args.id === undefined ? 'create_issue' : 'update_issue', args)
  }

  async createRun(goal: string): Promise<string> {
    if (!this.config.team) throw new LinearError('taskSource.linear.team is not set')
    const tool = this.direct.has('save_project') || this.direct.size === 0 ? 'save_project' : 'create_project'
    const reply = await this.call(tool, { name: redact(goal).slice(0, 80), description: redact(`Conductor run.\n\n${goal}`), team: this.config.team })
    const id = findString(reply, ['id', 'slugId', 'name'])
    if (!id) throw new LinearError(`${tool}: reply has no project id`)
    return id
  }

  async finishRun(runKey: string, outcome: 'completed' | 'stopped'): Promise<void> {
    const tool = this.direct.has('save_project') || this.direct.size === 0 ? 'save_project' : 'update_project'
    try {
      await this.call(tool, { id: runKey, state: outcome === 'completed' ? 'completed' : 'canceled' })
    } catch (err) {
      this.host.log(`linear: closing project ${runKey} skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async createTask(task: Task, runKey: string | undefined, description: string, labels: readonly string[]): Promise<string> {
    const base: JsonObject = {
      title: redact(task.title).slice(0, 250), description, team: this.config.team,
      ...(runKey ? { project: runKey } : {}), state: this.config.statusMap[task.status] ?? this.config.statusMap.planned,
    }
    let reply: JsonObject
    try {
      reply = await this.saveIssue({ ...base, labels: [...labels] })
    } catch {
      // Labels that do not exist in the workspace are refused: the issue goes in without them.
      reply = await this.saveIssue(base)
    }
    const key = findString(reply, ['identifier', 'id'])
    if (!key) throw new LinearError('save_issue: reply has no identifier')
    return key
  }

  async relate(blockerKey: string, blockedKey: string): Promise<void> {
    try {
      await this.saveIssue({ id: blockedKey, blockedBy: [blockerKey] })
    } catch (err) {
      this.host.log(`linear: ${blockerKey} blocks ${blockedKey} skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  stateFor(status: TaskStatus): string | undefined {
    return this.config.statusMap[status]
  }

  async move(key: string, move: BoardMove): Promise<void> {
    if (move.state !== undefined) await this.saveIssue({ id: key, state: move.state })
    if (move.labels !== undefined) {
      try {
        await this.saveIssue({ id: key, labels: [...move.labels] })
      } catch (err) {
        this.host.log(`linear: labels of ${key} skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async comment(key: string, body: string): Promise<void> {
    const tool = this.direct.has('save_comment') || this.direct.size === 0 ? 'save_comment' : 'create_comment'
    await this.call(tool, { issueId: key, body })
  }

  /** Linear's MCP server has no update tool: progress stays in the local task file. */
  async publishUpdate(_runKey: string | undefined, _body: string): Promise<void> {
    this.host.log('linear: progress updates stay in the local task file (Linear has no update tool)')
  }

  async cancelledKeys(runKey: string): Promise<Set<string>> {
    const reply = await this.call('list_issues', { project: runKey, state: this.config.cancelledState, limit: 100, includeCompleted: true })
    const issues = [...objectsAt(reply, 'issues'), ...objectsAt(reply, 'items'), ...objectsAt(reply, 'nodes')]
    return new Set(issues.flatMap(i => {
      const k = stringAt(i, 'identifier')
      return k ? [k] : []
    }))
  }

  async check(): Promise<string> {
    const lines = [`server: ${this.config.server}`, `tools: ${this.upserts ? 'save_* (upsert)' : 'create_/update_'}`]
    const teams = await this.call('list_teams', {})
    const list = [...objectsAt(teams, 'teams'), ...objectsAt(teams, 'items'), ...objectsAt(teams, 'nodes')]
    lines.push(`teams: ${list.map(t => `${stringAt(t, 'name') ?? '?'} (${stringAt(t, 'key') ?? '?'})`).join(', ') || 'none'}`)
    if (this.config.team) {
      const statuses = await this.call('list_issue_statuses', { team: this.config.team })
      const states = [...objectsAt(statuses, 'items'), ...objectsAt(statuses, 'statuses'), ...objectsAt(statuses, 'nodes')].map(s => stringAt(s, 'name')).filter(Boolean)
      const missing = Object.values(this.config.statusMap).filter(s => s && !states.includes(s))
      lines.push(`team ${this.config.team} states: ${states.join(', ') || '?'}${missing.length ? ` · not found: ${[...new Set(missing)].join(', ')} (set taskSource.linear.statusMap)` : ''}`)
    } else {
      lines.push('team is not set in .conductor/config.json (taskSource.linear.team)')
    }
    return lines.join('\n')
  }
}

/** Linear as the task source. */
export class LinearTaskSource extends RemoteTaskSource {
  constructor(host: Host, local: LocalFileTaskSource, config: LinearSettings, direct: ReadonlySet<string>) {
    super(host, local, new LinearBoard(host, config, direct), true)
  }
}
