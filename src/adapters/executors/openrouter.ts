import type { ExecutorConfig } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import { redact } from '../../core/redact.ts'
import type { ExecutorResult, Task } from '../../core/domain.types.ts'
import { lastChars, needsOpenRouterKey } from './executor.ts'
import type { Availability, Executor, ExecutorCommand, ExecutorRequest } from './executor.types.ts'
import { parseChatCompletion } from '../openrouter.ts'

const SYSTEM = `You write the content of exactly one file for a software project.
Answer with the file's full content and nothing else: no explanation, no Markdown fence around it.`

/**
 * OpenRouter as a worker (doc §8.5): text, not code edits. It answers with the
 * content of the task's first declared file (docs, fixtures, translations,
 * summaries), which the Conductor writes into the worktree and commits.
 * Only a task labelled `executor:openrouter` is routed here.
 */
export class OpenRouterExecutor implements Executor {
  readonly id = 'openrouter' as const
  readonly config: ExecutorConfig
  private readonly baseUrl: string
  private readonly fallbackModel: string

  constructor(config: ExecutorConfig, baseUrl: string, fallbackModel: string) {
    this.config = config
    this.baseUrl = baseUrl
    this.fallbackModel = fallbackModel
  }

  available(host: Host): Promise<Availability> {
    return needsOpenRouterKey(host)
  }

  async prepare(host: Host, req: ExecutorRequest): Promise<void> {
    const target = req.task.files?.[0]
    const body = {
      model: req.model ?? this.fallbackModel,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: redact(`${req.prompt}\n\nWrite the full content of: ${target ?? '(no file declared)'}`) },
      ],
      usage: { include: true },
    }
    await host.write(`${req.logDir}/request.json`, JSON.stringify(body))
  }

  command(req: ExecutorRequest): ExecutorCommand {
    // The key reaches curl through the environment, never argv (ps would show it).
    const script = 'curl -sS --fail-with-body --max-time "$3" -H "Authorization: Bearer $OPENROUTER_API_KEY" ' +
      '-H "content-type: application/json" -H "x-title: Uranus Conductor" --data-binary @"$1" "$2"'
    return {
      argv: ['/bin/sh', '-c', script, 'openrouter', `${req.logDir}/request.json`, `${this.baseUrl}/chat/completions`, String(Math.ceil(req.timeoutMs / 1000))],
      env: { OPENROUTER_API_KEY: req.openrouterKey ?? '' },
    }
  }

  async collect(host: Host, logDir: string, exitCode: number): Promise<ExecutorResult> {
    const out = (await host.read(`${logDir}/out.log`)) ?? ''
    const err = (await host.read(`${logDir}/err.log`)) ?? ''
    const body = parseChatCompletion(out)
    const text = body?.choices?.[0]?.message?.content ?? ''
    const ok = exitCode === 0 && body !== undefined && body.error === undefined && text.trim() !== ''
    const u = body?.usage
    return {
      ok,
      exitCode,
      summary: ok ? `wrote ${text.length} characters (${body?.model ?? 'model'})` : '',
      costUsd: u?.cost,
      tokens: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 } : undefined,
      raw: logDir,
      error: ok ? undefined : lastChars(body?.error?.message ?? (err || out || 'OpenRouter gave no answer'), 1500),
      content: ok ? stripFence(text) : undefined,
    }
  }

  async materialize(host: Host, req: { task: Task; worktree: string }, result: ExecutorResult): Promise<void> {
    const target = req.task.files?.[0]
    if (target === undefined || result.content === undefined) return
    if (target.startsWith('/') || target.split('/').includes('..')) throw new Error(`refusing to write outside the worktree: ${target}`)
    await host.write(`${req.worktree}/${target}`, result.content.endsWith('\n') ? result.content : `${result.content}\n`)
  }
}

/** Models wrap files in a fence despite being told not to. */
export function stripFence(text: string): string {
  const m = /^\s*```[\w.+-]*\n([\s\S]*?)\n```\s*$/.exec(text)
  return m?.[1] ?? text
}
