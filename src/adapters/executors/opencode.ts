import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { ExecutorResult } from '../../core/domain.types.ts'
import { lastChars, probe } from './executor.ts'
import type { Availability, Executor, ExecutorCommand, ExecutorRequest } from './executor.types.ts'
import { parseOpenCodeEvents } from './cli-output.ts'

/** `opencode run` (doc §8.3): cheap work with any model, through OpenRouter by default. */
export class OpenCodeExecutor implements Executor {
  readonly id = 'opencode' as const
  readonly config: ExecutorConfig
  private readonly fallbackModel: string

  /** `fallbackModel`: the OpenRouter model used when no tier model is configured. */
  constructor(config: ExecutorConfig, fallbackModel: string) {
    this.config = config
    this.fallbackModel = fallbackModel
  }

  /** Through OpenRouter it may use the key in the environment or its own stored login (`opencode auth`). */
  available(host: Host): Promise<Availability> {
    return probe(host, [this.config.bin, '--version'], `${this.config.bin} not found`)
  }

  /** OpenRouter models are addressed `openrouter/<vendor>/<model>` by OpenCode. */
  opencodeModel(model: string | undefined): string | undefined {
    if (this.config.provider !== 'openrouter') return model
    const id = model ?? this.fallbackModel
    return id.startsWith('openrouter/') ? id : `openrouter/${id}`
  }

  command(req: ExecutorRequest): ExecutorCommand {
    const c = this.config
    // --standalone: a private server rooted in the worktree, not the shared background one.
    // --auto approves tool use; acceptable only because the worktree is disposable.
    const argv = [c.bin, 'run', '--format', 'json', '--standalone', '--auto']
    const model = this.opencodeModel(req.model)
    if (model) argv.push('-m', model)
    argv.push(req.prompt)
    // Without a key in our environment, OpenCode's own stored login (`opencode auth`) is used: never blank it.
    return c.provider === 'openrouter' && req.openrouterKey ? { argv, env: { OPENROUTER_API_KEY: req.openrouterKey } } : { argv }
  }

  async collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult> {
    const out = (await host.read(`${logDir}/out.log`)) ?? ''
    const err = (await host.read(`${logDir}/err.log`)) ?? ''
    const texts: string[] = []
    let cost: number | undefined
    let tokens: ExecutorResult['tokens']
    let failed = false
    for (const ev of parseOpenCodeEvents(out)) {
      if (ev.error !== undefined || ev.type === 'error') failed = true
      const part = ev.part
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      if (typeof part?.cost === 'number') cost = (cost ?? 0) + part.cost
      if (part?.tokens?.input !== undefined) {
        tokens = { input: (tokens?.input ?? 0) + part.tokens.input, output: (tokens?.output ?? 0) + (part.tokens.output ?? 0) }
      }
    }
    const summary = (texts.at(-1) ?? '').trim()
    const ok = exitCode === 0 && !failed && summary !== ''
    return {
      ok,
      exitCode,
      summary,
      costUsd: cost,
      tokens,
      raw: logDir,
      error: ok ? undefined : lastChars(err || out || 'opencode produced no answer', 1500),
    }
  }
}
