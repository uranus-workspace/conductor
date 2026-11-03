// The worker CLIs' JSON outputs, read field by field: a CLI that changes its output
// gives an undefined field, never a wrongly typed one.
import { booleanAt, isJsonObject, numberAt, objectAt, objectsAt, stringAt, tryParse } from '../../core/json.ts'
import type { AgyJson, ClaudeJson, CodexUsage, CursorJson, OpenCodeEvent } from './cli-output.types.ts'
import { ndjson } from './executor.ts'

/** `claude -p --output-format json`. */
export function parseClaudeJson(text: string): ClaudeJson | undefined {
  const o = tryParse(text.trim())
  if (!isJsonObject(o)) return undefined
  const u = objectAt(o, 'usage')
  return {
    is_error: booleanAt(o, 'is_error'),
    result: stringAt(o, 'result'),
    total_cost_usd: numberAt(o, 'total_cost_usd'),
    usage: u && {
      input_tokens: numberAt(u, 'input_tokens'),
      output_tokens: numberAt(u, 'output_tokens'),
      cache_read_input_tokens: numberAt(u, 'cache_read_input_tokens'),
      cache_creation_input_tokens: numberAt(u, 'cache_creation_input_tokens'),
    },
  }
}

/** `cursor-agent -p --output-format json`. */
export function parseCursorJson(text: string): CursorJson | undefined {
  const o = tryParse(text.trim())
  if (!isJsonObject(o)) return undefined
  return { is_error: booleanAt(o, 'is_error'), result: stringAt(o, 'result') }
}

/** `agy -p --output-format json`. */
export function parseAgyJson(text: string): AgyJson | undefined {
  const o = tryParse(text.trim())
  if (!isJsonObject(o)) return undefined
  const u = objectAt(o, 'usage')
  return {
    status: stringAt(o, 'status'),
    response: stringAt(o, 'response'),
    usage: u && { input_tokens: numberAt(u, 'input_tokens'), output_tokens: numberAt(u, 'output_tokens'), thinking_tokens: numberAt(u, 'thinking_tokens') },
    denied_actions: objectsAt(o, 'denied_actions').map(d => ({ action: stringAt(d, 'action') })),
  }
}

/** `opencode run --format json`: one event per line, non-JSON lines skipped. */
export function parseOpenCodeEvents(text: string): OpenCodeEvent[] {
  return ndjson(text).filter(isJsonObject).map(ev => {
    const part = objectAt(ev, 'part')
    const tokens = part && objectAt(part, 'tokens')
    return {
      type: stringAt(ev, 'type'),
      error: ev.error,
      part: part && {
        type: stringAt(part, 'type'),
        text: stringAt(part, 'text'),
        cost: numberAt(part, 'cost'),
        tokens: tokens && { input: numberAt(tokens, 'input'), output: numberAt(tokens, 'output') },
      },
    }
  })
}

/** `codex exec --json`: token usage summed over its events; undefined when none reported any. */
export function parseCodexUsage(text: string): CodexUsage | undefined {
  let usage: CodexUsage | undefined
  for (const ev of ndjson(text).filter(isJsonObject)) {
    const u = objectAt(ev, 'usage')
    const input = u && numberAt(u, 'input_tokens')
    if (u === undefined || input === undefined) continue
    usage = { input: (usage?.input ?? 0) + input, output: (usage?.output ?? 0) + (numberAt(u, 'output_tokens') ?? 0) }
  }
  return usage
}
