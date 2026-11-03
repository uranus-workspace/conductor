import type { Host } from '../core/host.types.ts'
import type { ChatCompletion, OpenRouterRequest, OpenRouterResult } from './openrouter.types.ts'
import { isJsonObject, numberAt, objectAt, objectsAt, stringAt, tryParse } from '../core/json.ts'

/** An OpenRouter chat completion, read field by field. */
export function parseChatCompletion(text: string): ChatCompletion | undefined {
  const o = tryParse(text)
  if (!isJsonObject(o)) return undefined
  const usage = objectAt(o, 'usage')
  const error = objectAt(o, 'error')
  return {
    model: stringAt(o, 'model'),
    choices: objectsAt(o, 'choices').map(c => {
      const message = objectAt(c, 'message')
      return { message: message && { content: stringAt(message, 'content') } }
    }),
    usage: usage && { prompt_tokens: numberAt(usage, 'prompt_tokens'), completion_tokens: numberAt(usage, 'completion_tokens'), cost: numberAt(usage, 'cost') },
    error: error && { message: stringAt(error, 'message') ?? 'error' },
  }
}

/**
 * One chat completion through OpenRouter (doc §8.5), over the host's network.
 * The key comes from OPENROUTER_API_KEY and is never logged or returned.
 */
export async function openrouterComplete(host: Host, baseUrl: string, req: OpenRouterRequest): Promise<OpenRouterResult> {
  const key = await host.openrouterKey()
  if (!key) return { ok: false, error: 'OPENROUTER_API_KEY is not set' }
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: req.prompt },
  ]
  const res = await host.fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-title': 'Uranus Conductor',
    },
    body: JSON.stringify({
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      usage: { include: true },
    }),
  })
  const body = parseChatCompletion(res.text)
  if (body === undefined) return { ok: false, status: res.status, error: `non-JSON reply (${res.status})` }
  if (!res.ok || body.error) return { ok: false, status: res.status, error: body.error?.message ?? `HTTP ${res.status}` }
  const text = body.choices?.[0]?.message?.content ?? ''
  const u = body.usage
  return {
    ok: true,
    text,
    model: body.model ?? req.model,
    costUsd: u?.cost,
    tokens: u ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 } : undefined,
  }
}
