import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { ExecutorResult, ReviewVerdict } from '../../core/domain.types.ts'
import { lastChars, needsOpenRouterKey, parseVerdict, probe } from './executor.ts'
import type { Availability, Executor, ExecutorCommand, ExecutorRequest } from './executor.types.ts'
import { parseClaudeJson } from './cli-output.ts'

/** `claude -p` in the task's worktree (doc §8.4, preference 2). */
export class ClaudeExecutor implements Executor {
  readonly id = 'claude' as const
  readonly config: ExecutorConfig

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  async available(host: Host): Promise<Availability> {
    if (this.config.provider === 'openrouter') {
      const key = await needsOpenRouterKey(host)
      if (!key.ok) return key
    }
    return probe(host, [this.config.bin, '--version'], `${this.config.bin} not found`)
  }

  command(req: ExecutorRequest): ExecutorCommand {
    const c = this.config
    const viaOpenRouter = c.provider === 'openrouter'
    const argv = [c.bin, '-p', req.prompt, '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config']
    // Outside --bare, Claude Code's own login (claude.ai, the Keychain) wins over the gateway's key and the
    // request reaches OpenRouter without credentials (found live). --bare reads ANTHROPIC_API_KEY alone; it
    // also skips CLAUDE.md discovery, so the worktree's CLAUDE.md is handed over explicitly (prepare()).
    if (viaOpenRouter) argv.push('--bare', '--append-system-prompt-file', `${req.logDir}/context.md`)
    if (req.model) argv.push('--model', req.model)
    if (req.budgetUsd !== undefined) argv.push('--max-budget-usd', String(req.budgetUsd))
    if (req.mode === 'review') {
      // Read-only: plan mode edits nothing; the verdict is parsed from the final text.
      argv.push('--permission-mode', 'plan')
    } else if (c.permissionMode) {
      argv.push('--permission-mode', c.permissionMode)
    }
    // Variadic flags last: nothing positional may follow them.
    if (c.allowedTools?.length) argv.push('--allowedTools', ...c.allowedTools)
    if (c.disallowedTools?.length) argv.push('--disallowedTools', ...c.disallowedTools)

    if (viaOpenRouter) {
      // OpenRouter's Anthropic-compatible endpoint; the key never rides argv.
      return { argv, env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_API_KEY: req.openrouterKey ?? '' }, unset: ['ANTHROPIC_AUTH_TOKEN'] }
    }
    // An API key in the environment silently switches billing from the plan to tokens.
    return { argv, unset: ['ANTHROPIC_API_KEY'] }
  }

  /** Under --bare, the project's CLAUDE.md is passed explicitly: copied next to the job (empty when there is none). */
  async prepare(host: Host, req: ExecutorRequest): Promise<void> {
    if (this.config.provider !== 'openrouter') return
    const context = (await host.read(`${req.worktree}/CLAUDE.md`)) ?? ''
    await host.write(`${req.logDir}/context.md`, context)
  }

  async collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult> {
    const out = (await host.read(`${logDir}/out.log`)) ?? ''
    const err = (await host.read(`${logDir}/err.log`)) ?? ''
    const parsed = parseClaudeJson(out)
    if (parsed === undefined) {
      return { ok: false, exitCode, summary: lastChars(out), raw: logDir, error: lastChars(err || out || 'no output', 1500) }
    }
    const u = parsed.usage
    return {
      ok: exitCode === 0 && parsed.is_error !== true,
      exitCode,
      summary: parsed.result ?? '',
      costUsd: parsed.total_cost_usd,
      tokens: u ? { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 } : undefined,
      raw: logDir,
      error: parsed.is_error ? parsed.result : undefined,
    }
  }

  async verdict(host: Host, logDir: string, exitCode: number): Promise<ReviewVerdict | undefined> {
    const result = await this.collect(host, logDir, exitCode)
    return result.ok ? parseVerdict(result.summary) : undefined
  }
}
