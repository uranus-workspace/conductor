// Live smoke run: the real Conductor core, the real worker CLIs, a throwaway git repo.
// Costs real tokens. Usage: node tests/live/smoke.ts [worker ...]
// (default: claude codex antigravity opencode). Exit 0 when every task merged.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { AntigravityExecutor } from '../../src/adapters/executors/antigravity.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { CodexExecutor } from '../../src/adapters/executors/codex.ts'
import { CursorExecutor } from '../../src/adapters/executors/cursor.ts'
import { OpenCodeExecutor } from '../../src/adapters/executors/opencode.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { Conductor } from '../../src/core/conductor.ts'
import { parseConfig } from '../../src/core/config.ts'
import type { ExecutorId, PlanInput } from '../../src/core/domain.types.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workers = (process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex', 'antigravity', 'opencode']) as ExecutorId[]
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`)

const root = mkdtempSync(join(tmpdir(), 'conductor-live-'))
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
writeFileSync(join(root, 'README.md'), '# live smoke\n')
git('add', '.')
git('-c', 'user.name=smoke', '-c', 'user.email=smoke@localhost', 'commit', '-q', '-m', 'init')
log(`repo ${root}`)

// The key as the mod finds it: the environment, else the macOS Keychain (/conduct key).
const keychain = (): string | undefined => {
  try {
    return execFileSync('/bin/sh', [join(pluginRoot, 'scripts/openrouter-key.sh'), 'get'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
const openrouterKey = process.env.OPENROUTER_API_KEY || keychain()
// OpenRouter is the gateway when there is a key; otherwise each CLI's own login. CONDUCTOR_GATEWAY overrides.
const gateway = process.env.CONDUCTOR_GATEWAY ?? (openrouterKey ? 'openrouter' : 'native')
log(`gateway: ${gateway}${gateway === 'native' ? ' (no OPENROUTER_API_KEY)' : ''}`)
const config = parseConfig(JSON.stringify({
  gateway,
  heartbeatMs: 5000,
  checks: ['ls *.txt > /dev/null'],
  timeouts: { implementMs: 8 * 60_000, checkMs: 60_000, reviewMs: 5 * 60_000 },
  concurrency: { total: 4 },
  budgets: { taskUsd: 1, runUsd: 5, dayUsd: 10 },
}))
const home = mkdtempSync(join(tmpdir(), 'conductor-live-home-'))
const host = nodeHost(root, pluginRoot, { openrouterKey, home })
const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
const conductor = new Conductor(host, source, new RuleDecisionModel(config.riskPaths), [
  new ClaudeExecutor(config.executors.claude),
  new CodexExecutor(config.executors.codex),
  new OpenCodeExecutor(config.executors.opencode, config.openrouter.defaultModel),
  new CursorExecutor(config.executors.cursor),
  new AntigravityExecutor(config.executors.antigravity),
], config, {
  toast: t => log(`toast: ${t}`),
  wake: async t => log(`WAKE maestro:\n${t}`),
  summary: async () => undefined,
  board: async () => undefined,
})

const available = await conductor.detectExecutors()
log(`available: ${available.join(', ')}`)
const missing = workers.filter(w => !available.includes(w))
if (missing.length) log(`not available, skipped: ${missing.join(', ')}`)
const used = workers.filter(w => available.includes(w))

const tasks: PlanInput[] = used.map(w => ({
  key: w,
  title: `Create hello-${w}.txt`,
  description: `Create a new file named hello-${w}.txt at the repository root containing exactly one line: hello from ${w}`,
  acceptance: [`hello-${w}.txt exists at the root`, `its only line is "hello from ${w}"`],
  files: [`hello-${w}.txt`],
  // CONDUCTOR_SMOKE_TEMPLATE pins the graph template (feature: an independent review and the judge).
  labels: [`executor:${w}`, ...(process.env.CONDUCTOR_SMOKE_TEMPLATE ? [`template:${process.env.CONDUCTOR_SMOKE_TEMPLATE}`] : [])],
}))
tasks.push({
  key: 'index',
  title: 'Create index.txt listing the hello files',
  description: `Create index.txt at the repository root listing, one per line and sorted, the names of the files matching hello-*.txt in the root (${used.map(w => `hello-${w}.txt`).join(', ')}).`,
  acceptance: ['index.txt exists', 'it lists every hello-*.txt file of the root, one per line, sorted'],
  files: ['index.txt'],
  dependsOn: used,
  labels: [`executor:${used.includes('codex') ? 'codex' : used[0]}`],
})

const runId = await conductor.createRun('live smoke')
await conductor.plan(runId, tasks)
const started = Date.now()
let last = ''
while (Date.now() - started < 25 * 60_000) {
  await conductor.tick(runId)
  const { run, tasks: now, text } = await conductor.status(runId)
  if (text !== last) {
    log(`\n${text}`)
    last = text
  }
  // Settled: nothing runs and nothing can start (a classified task left here is blocked).
  const depsMerged = (t: (typeof now)[number]) => t.dependsOn.every(id => now.find(d => d.id === id)?.status === 'merged')
  const moving = now.some(t => t.job !== undefined || ['planned', 'ready', 'dispatched', 'running', 'verifying', 'approved', 'done'].includes(t.status) ||
    (t.status === 'classified' && depsMerged(t)))
  if (run.status === 'completed' || (!moving && !now.some(t => t.status === 'failed' && t.attempts.length < 1 + config.maxRetries))) break
  await new Promise(r => setTimeout(r, config.heartbeatMs))
}

const { run, tasks: final } = await conductor.status(runId)
log(`run ${run.status} in ${Math.round((Date.now() - started) / 1000)} s`)
for (const t of final) {
  const a = t.attempts.at(-1)
  log(`${t.id} ${t.status} ${a?.executor}/${a?.tier} attempts=${t.attempts.length} verdict=${a?.verdict ?? '-'} cost=${a?.costUsd ?? '?'} tokens=${JSON.stringify(a?.tokens ?? null)} logs=${a?.logDir}`)
  if (t.status !== 'merged') log(`  note: ${t.note}`)
}
log(await conductor.costText(runId))
if (run.integrationBranch) {
  for (const f of git('ls-tree', '--name-only', run.integrationBranch).split('\n').filter(n => n.endsWith('.txt'))) {
    log(`${f}: ${JSON.stringify(git('show', `${run.integrationBranch}:${f}`))}`)
  }
}
process.exit(final.every(t => t.status === 'merged') ? 0 : 1)
