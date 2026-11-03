import type {
  ConductorConfig, ConductorConfigInput, ExecutorConfig, ExecutorSettings, Provider, SwitchOptions, TierModels,
} from './config.types.ts'
import { OPENROUTER_CAPABLE, WORKERS } from './constants.ts'
import type { Tier, WorkerId } from './domain.types.ts'
import type { JsonObject } from './json.types.ts'

/** The defaults, before resolution. Model ids are OpenRouter's (`vendor/model`) or each CLI's own names. */
export const DEFAULT_SETTINGS: ConductorConfigInput = {
  enabled: true,
  gateway: 'openrouter',
  worktreeRoot: '',
  heartbeatMs: 20_000,
  maxRetries: 2,
  concurrency: { claude: 2, codex: 2, cursor: 2, opencode: 3, antigravity: 2, openrouter: 3, total: 4 },
  timeouts: { implementMs: 15 * 60_000, checkMs: 10 * 60_000, reviewMs: 5 * 60_000 },
  setup: [],
  checks: [],
  review: { enabled: true, executor: 'auto' },
  graph: { researchExecutor: 'opencode', securityCommand: '' },
  verifyThreshold: 0.8,
  scopeCreepThreshold: 0.3,
  budgets: { taskUsd: 5, runUsd: 50, dayUsd: 100 },
  riskPaths: [
    '(^|/)auth/', '(^|/)billing/', '(^|/)payments?/', '(^|/)migrations?/',
    'tax', '(^|/)\\.env', '(^|/)config/', '(^|/)secrets?/',
  ],
  executors: {
    claude: {
      enabled: true,
      bin: 'claude',
      models: {
        openrouter: { cheap: 'anthropic/claude-haiku-5.5', standard: 'anthropic/claude-sonnet-5.5', strong: 'anthropic/claude-opus-5.5' },
        native: { cheap: 'haiku', standard: 'sonnet', strong: 'opus' },
      },
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status:*)', 'Bash(git diff:*)'],
      disallowedTools: ['Bash(git push:*)', 'Bash(git commit:*)', 'WebFetch'],
    },
    codex: {
      enabled: true,
      bin: 'codex',
      models: {
        openrouter: { cheap: 'openai/gpt-5.1-codex-mini', standard: 'openai/gpt-5.3-codex', strong: 'openai/gpt-5.1-codex-max' },
        native: {},
      },
    },
    opencode: {
      enabled: true,
      bin: 'opencode',
      models: {
        openrouter: { cheap: 'deepseek/deepseek-v4.1-flash', standard: 'google/gemini-3.8-flash', strong: 'anthropic/claude-sonnet-5.5' },
        native: {},
      },
    },
    // Cursor's headless CLI is `agent`, `cursor-agent` or `cursor agent` depending on the install. No OpenRouter route.
    cursor: { enabled: true, bin: 'cursor-agent', models: { openrouter: {}, native: {} } },
    // Writes inside the worktree are allowed per session; allowedTools adds agy rules (`command(npm test)`). No OpenRouter route.
    antigravity: {
      enabled: true,
      bin: 'agy',
      models: { openrouter: {}, native: {} },
      permissionMode: 'accept-edits',
      allowedTools: ['command(ls)', 'command(cat)', 'command(git status)', 'command(git diff)'],
    },
    // Text only (docs, fixtures): curl to OpenRouter's chat completions.
    openrouter: {
      enabled: true,
      bin: 'curl',
      models: { openrouter: { cheap: 'openai/gpt-5.4-mini', standard: 'openai/gpt-5.4-mini', strong: 'anthropic/claude-sonnet-5.5' }, native: {} },
    },
  },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-5.4-mini' },
  decision: { mode: 'shadow', thresholds: {}, monitorRate: 0.1 },
  jev: { baseUrl: 'https://openrouter.ai/api', model: 'typesafe/jev-1.14', timeoutMs: 3000 },
  taskSource: {
    kind: 'local',
    uranus: { server: 'auto', projectKey: '', pullCancellations: true },
    jira: {
      server: 'auto', cloudId: '', site: '', projectKey: '', issueType: 'Task', epicType: 'Epic',
      statusMap: {
        ready: 'To Do', dispatched: 'In Progress', running: 'In Progress', verifying: 'In Progress',
        needs_review: 'In Review', approved: 'In Review', done: 'In Review', merged: 'Done', cancelled: 'Cancelled',
      },
      cancelledStatuses: ['Cancelled', 'Canceled', "Won't Do"],
    },
    linear: {
      server: 'auto', team: '',
      statusMap: {
        planned: 'Backlog', classified: 'Backlog', ready: 'Todo', dispatched: 'In Progress', running: 'In Progress',
        verifying: 'In Progress', needs_review: 'In Review', approved: 'In Review', done: 'In Review', merged: 'Done', cancelled: 'Canceled',
      },
      cancelledState: 'Canceled',
    },
  },
  figma: { server: 'auto', clientFrameworks: '', maxChars: 6000 },
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep merge: objects merge key by key, everything else (arrays included) replaces. */
export function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T
  const out: JsonObject = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as JsonObject)[k], v)
  return out as T
}

/** A worker's provider: its own override, else the gateway; native where OpenRouter is not an option. */
export function providerOf(id: WorkerId, settings: ExecutorSettings, gateway: Provider): Provider {
  if (id === 'openrouter') return 'openrouter'
  if (!OPENROUTER_CAPABLE.includes(id)) return 'native'
  return settings.provider ?? gateway
}

/** Decides every worker's provider: the config the rest of the code reads. */
export function resolveConfig(input: ConductorConfigInput): ConductorConfig {
  const executors = {} as Record<WorkerId, ExecutorConfig>
  for (const id of WORKERS) {
    const settings = input.executors[id]
    executors[id] = { ...settings, provider: providerOf(id, settings, input.gateway) }
  }
  return { ...input, executors }
}

export const DEFAULT_CONFIG: ConductorConfig = resolveConfig(DEFAULT_SETTINGS)

export function parseConfig(text: string | undefined): ConductorConfig {
  if (text === undefined || text.trim() === '') return DEFAULT_CONFIG
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw)) throw new Error('.conductor/config.json must hold a JSON object')
  return resolveConfig(merge(DEFAULT_SETTINGS, raw))
}

/** The model a worker runs a tier on, under its provider; undefined lets the CLI pick its default. */
export function modelFor(config: ExecutorConfig, tier: Tier): string | undefined {
  const models: TierModels = config.models[config.provider]
  return models[tier]
}

export const workerOption = (id: WorkerId): string => `worker_${id}`

/**
 * Applies the settings menu's switches over the project's config. A switch
 * only turns things off: on, the project's own `enabled` stands.
 */
export function applySwitches(config: ConductorConfig, options: SwitchOptions): ConductorConfig {
  const off = (key: string) => options[key] === false
  const executors = { ...config.executors }
  for (const id of WORKERS) {
    if (off(workerOption(id))) executors[id] = { ...executors[id], enabled: false }
  }
  return { ...config, enabled: config.enabled && !off('enabled'), executors }
}

export const isWorker = (id: string): id is WorkerId => (WORKERS as readonly string[]).includes(id)
