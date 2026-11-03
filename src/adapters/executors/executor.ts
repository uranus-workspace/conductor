import type { ReviewVerdict } from '../../core/domain.types.ts'
import type { Host } from '../../core/host.types.ts'
import { arrayAt, isJsonObject, stringAt, tryParse } from '../../core/json.ts'
import type { Availability } from './executor.types.ts'

/** Parses the lines of an NDJSON stream, skipping anything that is not JSON. */
export function ndjson(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // tolerate partial or non-JSON lines
    }
  }
  return out
}

export function parseVerdict(text: string | undefined): ReviewVerdict | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  const v = tryParse(text.slice(start, end + 1))
  if (!isJsonObject(v)) return undefined
  const verdict = stringAt(v, 'verdict')
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'review') return undefined
  return { verdict, summary: stringAt(v, 'summary') ?? '', issues: arrayAt(v, 'issues').map(String) }
}

/** Runs a probe command (`--version`, `login status`); available when it exits 0. */
export async function probe(host: Host, argv: readonly string[], reason: string): Promise<Availability> {
  try {
    return (await host.run(argv, { timeoutMs: 15_000 })).exitCode === 0 ? { ok: true } : { ok: false, reason }
  } catch {
    return { ok: false, reason }
  }
}

/** Workers routed through OpenRouter need the key in the environment, unless their CLI keeps its own login. */
export async function needsOpenRouterKey(host: Host): Promise<Availability> {
  return (await host.openrouterKey()) ? { ok: true } : { ok: false, reason: 'no OPENROUTER_API_KEY in the environment' }
}

export const lastChars = (text: string, max = 4000) => (text.length > max ? `…${text.slice(-max)}` : text)
