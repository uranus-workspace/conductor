import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { ExecutorResult, ReviewVerdict } from '../../core/domain.types.ts'
import { lastChars, parseVerdict, probe } from './executor.ts'
import type { Availability, Executor, ExecutorCommand, ExecutorRequest } from './executor.types.ts'
import { parseAgyJson } from './cli-output.ts'

/** macOS resolves /var and /tmp under /private: a rule names both spellings. */
function spellings(dir: string): string[] {
  return /^\/(var|tmp)\//.test(dir) ? [dir, `/private${dir}`] : [dir]
}

/**
 * Per-session permissions (`--settings`, never saved): writes and edits inside
 * the worktree only, plus the extra rules the config lists. Headless agy cannot
 * prompt, and `accept-edits` alone refuses creating files.
 */
export function sessionSettings(worktree: string, extra: readonly string[]): string {
  const allow = spellings(worktree).flatMap(d => [`write_file(${d}/**)`, `edit_file(${d}/**)`])
  return JSON.stringify({ permissions: { allow: [...allow, ...extra] } })
}

/** Google Antigravity's CLI, `agy -p`, in the task's worktree. */
export class AntigravityExecutor implements Executor {
  readonly id = 'antigravity' as const
  readonly config: ExecutorConfig

  constructor(config: ExecutorConfig) {
    this.config = config
  }

  /** `agy models` also proves the login (it takes a few seconds). */
  available(host: Host): Promise<Availability> {
    return probe(host, [this.config.bin, 'models'], `${this.config.bin} not found or not logged in`)
  }

  command(req: ExecutorRequest): ExecutorCommand {
    const argv = [
      this.config.bin, '-p', req.prompt,
      '--output-format', 'json',
      '--disable-slash-commands',
      // Its own print timeout (5 min by default) must not cut the job before ours does.
      '--print-timeout', `${Math.ceil(req.timeoutMs / 1000)}s`,
    ]
    const mode = this.config.permissionMode ?? 'accept-edits'
    if (req.mode === 'review') argv.push('--mode', 'plan')
    else if (mode === 'skip') argv.push('--dangerously-skip-permissions')
    // agy matches command rules exactly, so each check the prompt asks for is allowed as written.
    else argv.push('--mode', mode, '--settings', sessionSettings(req.worktree, [...(this.config.allowedTools ?? []), ...(req.checks ?? []).map(c => `command(${c})`)]))
    if (req.model) argv.push('--model', req.model)
    return { argv }
  }

  async collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult> {
    const out = (await host.read(`${logDir}/out.log`)) ?? ''
    const err = (await host.read(`${logDir}/err.log`)) ?? ''
    const parsed = parseAgyJson(out)
    const summary = (parsed?.response ?? '').trim()
    const ok = exitCode === 0 && parsed?.status === 'SUCCESS' && summary !== ''
    const u = parsed?.usage
    return {
      ok,
      exitCode,
      summary: parsed ? summary : lastChars(out),
      tokens: u ? { input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) } : undefined,
      raw: logDir,
      error: ok ? undefined : lastChars(
        (parsed?.denied_actions?.length ? `denied: ${parsed.denied_actions.map(d => d.action).join(', ')} — add a rule to executors.antigravity.allowedTools. ` : '') +
          (err || (parsed?.status ? `status ${parsed.status}` : out) || 'antigravity produced no answer'),
        1500,
      ),
    }
  }

  async verdict(host: Host, logDir: string, exitCode: number): Promise<ReviewVerdict | undefined> {
    const result = await this.collect(host, logDir, exitCode)
    return result.ok ? parseVerdict(result.summary) : undefined
  }
}
