import type { JiraSettings } from '../../core/config.types.ts'
import type { Task, TaskStatus } from '../../core/domain.types.ts'
import type { Host } from '../../core/host.types.ts'
import { objectAt, objectsAt, stringAt } from '../../core/json.ts'
import type { JsonObject } from '../../core/json.types.ts'
import { redact } from '../../core/redact.ts'
import { findMcpServer, findString, replyObject } from '../mcp/mcp.ts'
import type { Board, BoardMove } from './board.types.ts'
import type { LocalFileTaskSource } from './local-file.ts'
import { RemoteTaskSource } from './remote-task-source.ts'

export class JiraError extends Error {}

/** The Atlassian Rovo MCP server's Jira tools: how `auto` recognises it. */
export const JIRA_SIGNATURE: readonly string[] = ['createJiraIssue', 'searchJiraIssuesUsingJql']

export const findJiraServer = (toolNames: readonly string[]): string | undefined => findMcpServer(toolNames, JIRA_SIGNATURE)

/**
 * Jira over the Atlassian Rovo MCP server (v2): run = epic, task = issue with the epic
 * as parent. v2 shows a few tools directly and reaches the rest through its `execute`
 * meta-tool (`execute({ name, cloudId, inputs })`); a tool the session does not list is
 * called that way. Labels, links and transitions are best effort where the server's
 * argument shapes are not documented: a refusal there leaves the labels on the
 * Conductor's side and is logged, it never stops the run.
 */
export class JiraBoard implements Board {
  readonly name = 'Jira'
  private readonly host: Host
  private readonly config: JiraSettings
  private readonly direct: ReadonlySet<string>
  private cloudId: string | undefined

  /** `direct`: the tools the session lists for this server (the rest go through `execute`). */
  constructor(host: Host, config: JiraSettings, direct: ReadonlySet<string>) {
    this.host = host
    this.config = config
    this.direct = direct
    this.cloudId = config.cloudId || undefined
  }

  private async raw(tool: string, args: JsonObject): Promise<JsonObject> {
    const res = await this.host.mcpCall(this.config.server, tool, args)
    if (res.isError) throw new JiraError(`${tool}: ${res.text.slice(0, 300)}`)
    return replyObject(res.text)
  }

  /** The Atlassian site: the configured cloudId, else the accessible site whose URL holds `site` (or the only one). */
  private async site(): Promise<string> {
    if (this.cloudId) return this.cloudId
    const reply = await this.raw('getAccessibleAtlassianResources', {})
    const sites = [...objectsAt(reply, 'items'), ...objectsAt(reply, 'resources'), ...objectsAt(reply, 'sites')]
    const match = sites.find(s => this.config.site && (stringAt(s, 'url') ?? '').includes(this.config.site)) ?? (sites.length === 1 ? sites[0] : undefined)
    const id = match && stringAt(match, 'id')
    if (!id) throw new JiraError(`cannot tell which Atlassian site to use (${sites.length} found): set taskSource.jira.cloudId or site`)
    this.cloudId = id
    return id
  }

  /** A Jira tool, directly when the session lists it, else through v2's `execute`. */
  private async call(tool: string, args: JsonObject): Promise<JsonObject> {
    const cloudId = await this.site()
    if (this.direct.has(tool) || !this.direct.has('execute')) return this.raw(tool, { cloudId, ...args })
    return this.raw('execute', { name: tool, cloudId, inputs: args })
  }

  /** A best-effort call: undocumented argument shapes may be refused; the run goes on. */
  private async tryCall(tool: string, args: JsonObject): Promise<void> {
    try {
      await this.call(tool, args)
    } catch (err) {
      this.host.log(`jira: ${tool} skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private key(reply: JsonObject, what: string): string {
    const key = findString(reply, ['key', 'issueKey'])
    if (!key) throw new JiraError(`${what}: reply has no issue key`)
    return key
  }

  async createRun(goal: string): Promise<string> {
    const reply = await this.call('createJiraIssue', {
      projectKey: this.config.projectKey, issueType: this.config.epicType,
      summary: redact(goal).slice(0, 250), description: redact(`Conductor run.\n\n${goal}`),
    })
    return this.key(reply, 'createJiraIssue (epic)')
  }

  async finishRun(runKey: string, outcome: 'completed' | 'stopped'): Promise<void> {
    await this.transitionTo(runKey, outcome === 'completed' ? this.config.statusMap.merged : this.config.statusMap.cancelled)
  }

  async createTask(task: Task, runKey: string | undefined, description: string, labels: readonly string[]): Promise<string> {
    const reply = await this.call('createJiraIssue', {
      projectKey: this.config.projectKey, issueType: this.config.issueType,
      summary: redact(task.title).slice(0, 250), description, ...(runKey ? { parent: runKey } : {}),
    })
    const key = this.key(reply, 'createJiraIssue')
    await this.setLabels(key, labels)
    return key
  }

  private async setLabels(key: string, labels: readonly string[]): Promise<void> {
    // Jira labels hold no spaces or colons in some sites' rules: `conductor:running` → `conductor-running`.
    await this.tryCall('editJiraIssue', { issueIdOrKey: key, fields: { labels: labels.map(l => l.replace(/[\s:]+/g, '-')) } })
  }

  async relate(blockerKey: string, blockedKey: string): Promise<void> {
    await this.tryCall('createJiraIssueLink', { type: 'Blocks', inwardIssue: blockedKey, outwardIssue: blockerKey })
  }

  stateFor(status: TaskStatus): string | undefined {
    return this.config.statusMap[status]
  }

  /** Workflows differ: the transition whose name or target status matches, case-insensitively; none → labels only. */
  private async transitionTo(key: string, state: string | undefined): Promise<void> {
    if (state === undefined) return
    const reply = await this.call('listJiraIssueTransitions', { issueIdOrKey: key })
    const wanted = state.toLowerCase()
    const match = objectsAt(reply, 'transitions').concat(objectsAt(reply, 'items')).find(t => {
      const to = objectAt(t, 'to')
      return (stringAt(t, 'name') ?? '').toLowerCase() === wanted || (to !== undefined && (stringAt(to, 'name') ?? '').toLowerCase() === wanted)
    })
    const id = match && stringAt(match, 'id')
    if (!id) {
      this.host.log(`jira: ${key} has no transition to "${state}"; its labels carry the status`)
      return
    }
    await this.call('transitionJiraIssue', { issueIdOrKey: key, transition: { id } })
  }

  async move(key: string, move: BoardMove): Promise<void> {
    if (move.state !== undefined) await this.transitionTo(key, move.state)
    if (move.labels !== undefined) await this.setLabels(key, move.labels)
  }

  async comment(key: string, body: string): Promise<void> {
    await this.call('addOrEditJiraIssueComment', { issueIdOrKey: key, commentBody: body })
  }

  /** Jira has no project updates: progress is a comment on the run's epic. */
  async publishUpdate(runKey: string | undefined, body: string): Promise<void> {
    if (runKey) await this.comment(runKey, body)
  }

  async cancelledKeys(runKey: string): Promise<Set<string>> {
    const statuses = this.config.cancelledStatuses.map(s => `"${s.replace(/"/g, '')}"`).join(', ')
    const reply = await this.call('searchJiraIssuesUsingJql', { jql: `parent = ${runKey} AND status in (${statuses})`, fields: ['status'], maxResults: 100 })
    const issues = [...objectsAt(reply, 'issues'), ...objectsAt(reply, 'items')]
    return new Set(issues.flatMap(i => {
      const k = stringAt(i, 'key')
      return k ? [k] : []
    }))
  }

  async check(): Promise<string> {
    const lines = [`server: ${this.config.server}`, `tools: ${this.direct.has('execute') ? 'direct + execute' : 'direct'}`]
    lines.push(`site (cloudId): ${await this.site()}`)
    if (this.config.projectKey) {
      const reply = await this.call('searchJiraIssuesUsingJql', { jql: `project = ${this.config.projectKey} ORDER BY created DESC`, fields: ['summary', 'status'], maxResults: 3 })
      const issues = [...objectsAt(reply, 'issues'), ...objectsAt(reply, 'items')]
      const sample = issues.map(i => {
        const fields = objectAt(i, 'fields')
        const status = fields && objectAt(fields, 'status')
        return `${stringAt(i, 'key') ?? '?'} [${(status && stringAt(status, 'name')) ?? '?'}]`
      })
      lines.push(`project ${this.config.projectKey}: ${sample.length ? sample.join('; ') : 'no issues yet'}`)
    } else {
      lines.push('projectKey is not set in .conductor/config.json (taskSource.jira.projectKey)')
    }
    return lines.join('\n')
  }
}

/** Jira as the task source. */
export class JiraTaskSource extends RemoteTaskSource {
  constructor(host: Host, local: LocalFileTaskSource, config: JiraSettings, direct: ReadonlySet<string>) {
    super(host, local, new JiraBoard(host, config, direct), true)
  }
}

