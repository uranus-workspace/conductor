// Redaction before text leaves the machine (Jev, OpenRouter, Uranus OS) and,
// when switched on, before the conversation stores it (LGPD). Regex is not a
// security boundary (doc §11): this lowers exposure, it does not guarantee it.

const SECRETS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-(?:or|ant|proj|live|test)?-?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [REDACTED]'],
  // KEY=value lines as in .env files, for names that look secret.
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{6,}["']?/g, '$1=[REDACTED]'],
]

const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g

function digits(s: string): number[] {
  return [...s.replace(/\D/g, '')].map(Number)
}

/** Check digits, so order numbers and timestamps of the same length are left alone. */
export function isCpf(s: string): boolean {
  const d = digits(s)
  if (d.length !== 11 || d.every(x => x === d[0])) return false
  const check = (len: number) => {
    const sum = d.slice(0, len).reduce((acc, x, i) => acc + x * (len + 1 - i), 0)
    const r = (sum * 10) % 11
    return r === 10 ? 0 : r
  }
  return check(9) === d[9] && check(10) === d[10]
}

export function isCnpj(s: string): boolean {
  const d = digits(s)
  if (d.length !== 14 || d.every(x => x === d[0])) return false
  const check = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const sum = weights.reduce((acc, w, i) => acc + w * (d[i] ?? 0), 0)
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  return check(12) === d[12] && check(13) === d[13]
}

export function redactSecrets(text: string): string {
  return SECRETS.reduce((t, [re, rep]) => t.replace(re, rep), text)
}

/** CPF and CNPJ with valid check digits (LGPD personal and company identifiers). */
export function redactPersonalIds(text: string): string {
  return text
    .replace(CNPJ, m => (isCnpj(m) ? '[CNPJ]' : m))
    .replace(CPF, m => (isCpf(m) ? '[CPF]' : m))
}

/** Everything that must not leave the machine. */
export function redact(text: string): string {
  return redactPersonalIds(redactSecrets(text))
}

/** Redacts every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(v => redactDeep(v)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T
  }
  return value
}
