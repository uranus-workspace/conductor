import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { ExecutorResult, ReviewVerdict } from '../../core/domain.types.ts'
import { lastChars, parseVerdict, probe } from './executor.ts'
import type { Availability, Executor, ExecutorCommand, ExecutorRequest } from './executor.types.ts'
import { parseCursorJson } from './cli-output.ts'

/**
 * Cursor's headless agent (doc §8.2): fast, mechanical edits across many files.
 * It has no locked mode (the project's hooks, MCP and plugins stay active), so
 * it is the least trusted worker: worktree only, never a folder with secrets.
 */
export class CursorExecutor implements Executor {
  readonly id = 'cursor' as const
  readonly config: ExecutorConfig

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  private get base(): string[] {
    return [this.config.bin, ...(this.config.binArgs ?? [])]
  }

  available(host: Host): Promise<Availability> {
    return probe(host, [...this.base, '--version'], `${this.base.join(' ')} not found`)
  }

  command(req: ExecutorRequest): ExecutorCommand {
    // Without --force it only proposes changes; review mode leaves it out.
    const argv = [...this.base, '-p', ...(req.mode === 'implement' ? ['--force'] : []), '--trust', '--output-format', 'json']
    if (req.model) argv.push('-m', req.model)
    argv.push(req.prompt)
    return { argv }
  }

  async collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult> {
    const out = (await host.read(`${logDir}/out.log`)) ?? ''
    const err = (await host.read(`${logDir}/err.log`)) ?? ''
    const parsed = parseCursorJson(out)
    const summary = (parsed?.result ?? '').trim()
    const ok = exitCode === 0 && parsed !== undefined && parsed.is_error !== true && summary !== ''
    return {
      ok,
      exitCode,
      summary: parsed ? summary : lastChars(out),
      raw: logDir,
      error: ok ? undefined : lastChars(err || out || 'cursor produced no answer', 1500),
    }
  }

  async verdict(host: Host, logDir: string, exitCode: number): Promise<ReviewVerdict | undefined> {
    const result = await this.collect(host, logDir, exitCode)
    return result.ok ? parseVerdict(result.summary) : undefined
  }
}
