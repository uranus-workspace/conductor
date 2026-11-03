import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { ExecutorResult, ReviewVerdict } from '../../core/domain.types.ts'
import { lastChars, needsOpenRouterKey, parseVerdict, probe } from './executor.ts'
import type { Availability, Executor, ExecutorCommand, ExecutorRequest } from './executor.types.ts'
import { parseCodexUsage } from './cli-output.ts'

const OPENROUTER_PROVIDER = [
  '-c', 'model_provider="openrouter"',
  '-c', 'model_providers.openrouter.name="OpenRouter"',
  '-c', 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
  '-c', 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
  '-c', 'model_providers.openrouter.wire_api="responses"',
]

/** `codex exec` (doc §8.1): implementer of well-specified tasks and the adversarial reviewer. */
export class CodexExecutor implements Executor {
  readonly id = 'codex' as const
  readonly config: ExecutorConfig

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  async available(host: Host): Promise<Availability> {
    if (this.config.provider === 'openrouter') {
      const key = await needsOpenRouterKey(host)
      if (!key.ok) return key
      return probe(host, [this.config.bin, '--version'], `${this.config.bin} not found`)
    }
    return probe(host, [this.config.bin, 'login', 'status'], `${this.config.bin} not found or not logged in (codex login)`)
  }

  command(req: ExecutorRequest): ExecutorCommand {
    const c = this.config
    const argv = [
      c.bin, 'exec',
      '--sandbox', req.mode === 'review' ? 'read-only' : 'workspace-write',
      '--ephemeral', '--skip-git-repo-check', '--json',
      '-C', req.worktree,
      // A fresh file per job: an old verdict is never read as a new one.
      '-o', `${req.logDir}/final.txt`,
    ]
    if (req.model) argv.push('-m', req.model)
    if (req.mode === 'review' && req.schemaPath) argv.push('--output-schema', req.schemaPath)
    if (c.provider === 'openrouter') argv.push(...OPENROUTER_PROVIDER)
    argv.push(req.prompt)
    return c.provider === 'openrouter' && req.openrouterKey ? { argv, env: { OPENROUTER_API_KEY: req.openrouterKey } } : { argv }
  }

  async collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult> {
    const final = (await host.read(`${logDir}/final.txt`)) ?? ''
    const out = (await host.read(`${logDir}/out.log`)) ?? ''
    const err = (await host.read(`${logDir}/err.log`)) ?? ''
    const tokens = parseCodexUsage(out)
    // Exit 0 AND a non-empty final message: a worker that said nothing did nothing.
    const ok = exitCode === 0 && final.trim() !== ''
    return {
      ok,
      exitCode,
      summary: final.trim(),
      tokens,
      raw: logDir,
      error: ok ? undefined : lastChars(err || out || 'codex produced no final message', 1500),
    }
  }

  async verdict(host: Host, logDir: string, exitCode: number): Promise<ReviewVerdict | undefined> {
    if (exitCode !== 0) return undefined
    return parseVerdict(await host.read(`${logDir}/final.txt`))
  }
}
