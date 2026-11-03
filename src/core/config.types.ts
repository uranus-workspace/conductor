import type { ExecutorId, TaskStatus, Tier, WorkerId } from './domain.types.ts'

/** How a worker reaches its models: its own login (`native`) or OpenRouter. */
export type Provider = 'native' | 'openrouter'

/** The model per tier, for one provider. */
export type TierModels = Partial<Record<Tier, string>>

/** Who takes the enumerable decisions (doc §7.3): rules only, Jev logged beside them, or Jev enforced. */
export type DecisionMode = 'rules' | 'shadow' | 'enforce'

/** The Jev answers an enforced decision may take, each above its own threshold. */
export type ThresholdKey = 'executor' | 'complexity' | 'risk' | 'needsHuman' | 'template'

export type TaskSourceKind = 'local' | 'uranus' | 'jira' | 'linear'

/** One worker as `.conductor/config.json` may write it: everything optional, merged over the defaults. */
export interface ExecutorSettings {
  /** Off: the worker leaves routing and review; jobs already running finish. */
  enabled: boolean
  bin: string
  /** Arguments between the binary and the CLI's own flags (`["agent"]` for `cursor agent`). */
  binArgs?: readonly string[]
  /** Overrides the global gateway for this worker; ignored by workers that cannot use OpenRouter. */
  provider?: Provider
  /** Models per provider and tier: OpenRouter ids (`anthropic/claude-sonnet-5.5`) or the CLI's own names. */
  models: Record<Provider, TierModels>
  /** Claude: --permission-mode. Antigravity: --mode (`accept-edits`), or `skip` for --dangerously-skip-permissions. */
  permissionMode?: string
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
}

/** A worker after config resolution: its provider is always decided. */
export interface ExecutorConfig extends ExecutorSettings {
  provider: Provider
}

export interface Timeouts {
  implementMs: number
  checkMs: number
  reviewMs: number
}

export interface Budgets {
  taskUsd: number
  runUsd: number
  dayUsd: number
}

export interface ReviewSettings {
  enabled: boolean
  /** `auto`: a worker other than the author, from another lab when possible. A named worker is used unless it is the author. */
  executor: ExecutorId | 'auto'
}

/** The graph nodes that run a configurable worker or command. */
export interface GraphSettings {
  /** The cheap worker of research nodes (reproduction, context). */
  researchExecutor: ExecutorId
  /** A security scanner run in the worktree (Umbriel, semgrep, ...); empty skips the security node. */
  securityCommand: string
}

export interface OpenRouterSettings {
  /** `https://openrouter.ai/api/v1`: chat completions for `ask_openrouter` and the `openrouter` worker. */
  baseUrl: string
  defaultModel: string
}

export interface DecisionSettings {
  mode: DecisionMode
  thresholds: Partial<Record<ThresholdKey, number>>
  /** Share of Jev calls asked twice, reshuffled, to measure consistency. */
  monitorRate: number
}

/** Jev through OpenRouter's System One API (`<baseUrl>/v1/systemone`), billed to the OpenRouter key. */
export interface JevSettings {
  baseUrl: string
  /** Pin a version (`typesafe/jev-1.14`) once thresholds are tuned; every answer logs the model that replied. */
  model: string
  timeoutMs: number
}

export interface UranusSettings {
  /** The MCP server as /mcp lists it, its tool-name spelling, or `auto` (found by its tools). */
  server: string
  /** The project runs become epics of (`TCG`). */
  projectKey: string
  /** Read cancellations made on the Uranus OS board back into the run. */
  pullCancellations: boolean
}

/** Jira through the Atlassian Rovo MCP server: a run is an epic, a task an issue under it. */
export interface JiraSettings {
  /** The MCP server's name, or `auto` (found by its Jira tools). */
  server: string
  /** The Atlassian site id; empty: found with getAccessibleAtlassianResources (the one whose URL holds `site`). */
  cloudId: string
  /** `yourteam.atlassian.net`, to pick the site when the token reaches several. */
  site: string
  projectKey: string
  issueType: string
  epicType: string
  /** The Jira status each Conductor status moves to (workflows differ: names, matched case-insensitively). */
  statusMap: Partial<Record<TaskStatus, string>>
  /** Jira statuses that mean "cancelled on the board". */
  cancelledStatuses: string[]
}

/** Linear through its MCP server: a run is a project, a task an issue in it. */
export interface LinearSettings {
  /** The MCP server's name, or `auto` (found by its Linear tools). */
  server: string
  /** The team (name or key) runs and issues belong to. */
  team: string
  /** The Linear workflow state each Conductor status moves to. */
  statusMap: Partial<Record<TaskStatus, string>>
  /** The Linear state that means "cancelled on the board". */
  cancelledState: string
}

export interface TaskSourceSettings {
  /** `local`: .conductor/tasks.json. `uranus`, `jira`, `linear`: that board over its MCP server, the local file kept beside it. */
  kind: TaskSourceKind
  uranus: UranusSettings
  jira: JiraSettings
  linear: LinearSettings
}

/** Figma through its MCP server: design references (links on a task) become context for workers. */
export interface FigmaSettings {
  /** The MCP server's name, or `auto` (found by get_design_context); empty disables it. */
  server: string
  /** Passed to get_design_context so the generated code matches the project (e.g. `react`). */
  clientFrameworks: string
  /** The most characters of context kept per link. */
  maxChars: number
}

/** The metrics ledger (/conduct stats): what each session, worker and model did and cost. */
export interface MetricsSettings {
  enabled: boolean
  /** Where the ledger goes; empty: ~/.conductor/metrics, shared by every project. */
  dir: string
}

export interface ConductorConfig {
  /** Off: no heartbeat, nothing planned or dispatched; workers already running finish on their own. */
  enabled: boolean
  /** The default way every LLM call leaves the machine: Jev, `ask_openrouter`, and the workers that can. */
  gateway: Provider
  /** Where worktrees go; empty: ~/.conductor/worktrees/<project>-<hash>, outside the project. */
  worktreeRoot: string
  heartbeatMs: number
  maxRetries: number
  concurrency: Partial<Record<ExecutorId, number>> & { total: number }
  timeouts: Timeouts
  /** Shell commands run in the worktree before the worker and before checks (e.g. `npm ci`). */
  setup: string[]
  /** Deterministic checks (tests, lint, build), run in the worktree after the worker. */
  checks: string[]
  review: ReviewSettings
  graph: GraphSettings
  verifyThreshold: number
  scopeCreepThreshold: number
  budgets: Budgets
  /** Path fragments (regex sources) that floor a task's risk at 4. */
  riskPaths: string[]
  executors: Record<WorkerId, ExecutorConfig>
  openrouter: OpenRouterSettings
  decision: DecisionSettings
  jev: JevSettings
  taskSource: TaskSourceSettings
  figma: FigmaSettings
  metrics: MetricsSettings
}

/** The config as written on disk, before defaults and resolution. */
export type ConductorConfigInput = Omit<ConductorConfig, 'executors'> & { executors: Record<WorkerId, ExecutorSettings> }

/** The settings menu's switches (plugin `userConfig`): one for the Conductor, one per worker, LGPD. */
export type SwitchOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>
