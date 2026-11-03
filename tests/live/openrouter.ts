// Live check of the OpenRouter gateway's direct calls: Jev (System One) and a chat completion.
// Costs real tokens (fractions of a cent). Usage: node tests/live/openrouter.ts
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JevClient, JevDecisionModel } from '../../src/adapters/decision/jev.ts'
import { openrouterComplete } from '../../src/adapters/openrouter.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { Task } from '../../src/core/domain.types.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const keychain = (): string | undefined => {
  try {
    return execFileSync('/bin/sh', [join(pluginRoot, 'scripts/openrouter-key.sh'), 'get'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
const openrouterKey = process.env.OPENROUTER_API_KEY || keychain()
if (!openrouterKey) {
  console.error('no OpenRouter key: set OPENROUTER_API_KEY or run /conduct key')
  process.exit(2)
}

// Node's own fetch stands in for $.http here.
const host = nodeHost(pluginRoot, pluginRoot, {
  openrouterKey,
  fetch: async (url, init) => {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
    return { status: res.status, ok: res.ok, text: await res.text() }
  },
})

const task: Task = {
  id: 'live-1', runId: 'live', title: 'Add rate limiting to the login endpoint',
  description: 'Limit failed login attempts to 5 per minute per account; return 429 after that.',
  acceptance: ['the 6th failed attempt within a minute returns 429', 'existing login tests pass'],
  files: ['src/auth/login.ts', 'src/auth/login.test.ts'], dependsOn: [], status: 'planned', attempts: [],
}

let failed = false
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failed = true
}

const jev = new JevDecisionModel(new JevClient(host, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }), DEFAULT_CONFIG.riskPaths)
try {
  const c = await jev.classify(task, { openTaskFiles: [], available: ['claude', 'codex', 'opencode'] })
  check('jev classify', c.source === 'jev' && c.risk >= 4, `model ${c.model}, executor ${c.executor}, complexity ${c.complexity}, risk ${c.risk}, tier ${c.tier}, template ${c.template ?? '-'}, confidence ${JSON.stringify(c.confidence)}`)
  const v = await jev.isVerified(task, { checksPassed: true, reviewVerdict: 'pass', changedFiles: ['src/auth/login.ts', 'src/auth/login.test.ts'], diffStat: '2 files changed, 48 insertions(+)' })
  check('jev verify', v.verified >= 0 && v.verified <= 1, `verified ${v.verified.toFixed(2)}, scopeCreep ${v.scopeCreep?.toFixed(2)}, model ${v.model}`)
} catch (err) {
  check('jev', false, String(err))
}

const chat = await openrouterComplete(host, DEFAULT_CONFIG.openrouter.baseUrl, {
  model: DEFAULT_CONFIG.openrouter.defaultModel, prompt: 'Reply with exactly: pong', maxTokens: 20,
})
check('ask_openrouter', chat.ok && chat.text.toLowerCase().includes('pong'), chat.ok ? `${chat.model} said ${JSON.stringify(chat.text.trim())}, US$ ${chat.costUsd}` : chat.error)

process.exit(failed ? 1 : 0)
