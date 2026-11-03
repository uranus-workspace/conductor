export interface ClaudeJson {
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

export interface CursorJson {
  is_error?: boolean
  result?: string
}

export interface AgyJson {
  status?: string
  response?: string
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number }
  denied_actions?: Array<{ action?: string }>
}

export interface OpenCodeEvent {
  type?: string
  part?: { type?: string; text?: string; cost?: number; tokens?: { input?: number; output?: number } }
  error?: unknown
}

/** Token usage summed over `codex exec --json` events. */
export interface CodexUsage {
  input: number
  output: number
}
