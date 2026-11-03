export interface OpenRouterRequest {
  model: string
  prompt: string
  system?: string
  maxTokens?: number
  temperature?: number
}

export type OpenRouterResult =
  | { ok: true; text: string; model: string; costUsd?: number; tokens?: { input: number; output: number } }
  | { ok: false; error: string; status?: number }

export interface ChatCompletion {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { message?: string }
}
