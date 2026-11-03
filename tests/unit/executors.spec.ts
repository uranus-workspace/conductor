import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { CodexExecutor } from '../../src/adapters/executors/codex.ts'
import { ndjson, parseVerdict } from '../../src/adapters/executors/executor.ts'
import type { ExecutorRequest } from '../../src/adapters/executors/executor.types.ts'
import { OpenCodeExecutor } from '../../src/adapters/executors/opencode.ts'
import { DEFAULT_CONFIG, merge, modelFor, parseConfig } from '../../src/core/config.ts'
import { nodeHost } from '../support/node-host.ts'

const req = (over: Partial<ExecutorRequest> = {}): ExecutorRequest => ({
  task: { id: 't', runId: 'r', title: 'x', description: 'y', acceptance: ['z'], dependsOn: [], status: 'ready', attempts: [] },
  worktree: '/wt', logDir: '/logs', prompt: 'PROMPT', mode: 'implement', timeoutMs: 1000, ...over,
})

describe('ClaudeExecutor', () => {
  it('builds a headless call with the prompt before the variadic flags and drops the API key', () => {
    const ex = new ClaudeExecutor({ ...DEFAULT_CONFIG.executors.claude, provider: 'native' })
    const cmd = ex.command(req({ model: 'sonnet', budgetUsd: 3 }))
    assert.deepEqual(cmd.argv.slice(0, 3), ['claude', '-p', 'PROMPT'])
    assert.ok(cmd.argv.includes('--max-budget-usd'))
    assert.equal(cmd.argv.indexOf('--allowedTools') > cmd.argv.indexOf('PROMPT'), true)
    assert.deepEqual(cmd.unset, ['ANTHROPIC_API_KEY'])
  })

  it('routes through OpenRouter in --bare, the key in the environment only, CLAUDE.md handed over', () => {
    const ex = new ClaudeExecutor(merge(DEFAULT_CONFIG.executors.claude, { provider: 'openrouter' }))
    const cmd = ex.command(req({ openrouterKey: 'sk-or-secret' }))
    assert.equal(cmd.env?.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
    assert.equal(cmd.env?.ANTHROPIC_API_KEY, 'sk-or-secret')
    assert.ok(cmd.argv.includes('--bare'))
    assert.equal(cmd.argv[cmd.argv.indexOf('--append-system-prompt-file') + 1], '/logs/context.md')
    assert.ok(!cmd.argv.join(' ').includes('sk-or-secret'))
  })

  it('reads result, cost and tokens from the JSON output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-'))
    await writeFile(join(dir, 'out.log'), JSON.stringify({ is_error: false, result: 'did it', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5 } }))
    const r = await new ClaudeExecutor(DEFAULT_CONFIG.executors.claude).collect(nodeHost(dir, dir), dir, 0)
    assert.equal(r.ok, true)
    assert.equal(r.summary, 'did it')
    assert.equal(r.costUsd, 0.12)
    assert.deepEqual(r.tokens, { input: 15, output: 4 })
  })
})

describe('CodexExecutor', () => {
  it('uses a read-only sandbox and the schema for reviews', () => {
    const cmd = new CodexExecutor(DEFAULT_CONFIG.executors.codex).command(req({ mode: 'review', schemaPath: '/s.json' }))
    assert.equal(cmd.argv[cmd.argv.indexOf('--sandbox') + 1], 'read-only')
    assert.equal(cmd.argv[cmd.argv.indexOf('--output-schema') + 1], '/s.json')
    assert.equal(cmd.argv[cmd.argv.indexOf('-o') + 1], '/logs/final.txt')
    assert.equal(cmd.argv.at(-1), 'PROMPT')
  })

  it('fails closed: exit 0 with an empty final message is not success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cx-'))
    await writeFile(join(dir, 'final.txt'), '')
    const ex = new CodexExecutor(DEFAULT_CONFIG.executors.codex)
    const r = await ex.collect(nodeHost(dir, dir), dir, 0)
    assert.equal(r.ok, false)
    assert.equal(await ex.verdict(nodeHost(dir, dir), dir, 0), undefined)
  })

  it('parses a verdict and token usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cx-'))
    await writeFile(join(dir, 'final.txt'), '{"verdict":"pass","summary":"ok","issues":[]}')
    await writeFile(join(dir, 'out.log'), 'noise\n{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":7}}\n')
    const ex = new CodexExecutor(DEFAULT_CONFIG.executors.codex)
    assert.deepEqual(await ex.verdict(nodeHost(dir, dir), dir, 0), { verdict: 'pass', summary: 'ok', issues: [] })
    assert.deepEqual((await ex.collect(nodeHost(dir, dir), dir, 0)).tokens, { input: 100, output: 7 })
  })
})

describe('OpenCodeExecutor', () => {
  it('defaults to an OpenRouter model and passes the key by env', () => {
    const ex = new OpenCodeExecutor(DEFAULT_CONFIG.executors.opencode, 'openai/gpt-4o-mini')
    const cmd = ex.command(req({ openrouterKey: 'k' }))
    assert.equal(cmd.argv[cmd.argv.indexOf('-m') + 1], 'openrouter/openai/gpt-4o-mini')
    assert.equal(cmd.env?.OPENROUTER_API_KEY, 'k')
    assert.equal(ex.opencodeModel('anthropic/claude-haiku'), 'openrouter/anthropic/claude-haiku')
  })

  it('leaves OpenCode\'s stored login alone when there is no key in the environment', () => {
    const ex = new OpenCodeExecutor(DEFAULT_CONFIG.executors.opencode, 'openai/gpt-4o-mini')
    assert.equal(ex.command(req()).env, undefined)
  })

  it('tolerates non-JSON lines and sums cost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-'))
    await writeFile(join(dir, 'out.log'), [
      'starting server…',
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'first' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', cost: 0.001, tokens: { input: 50, output: 5 } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'final report' } }),
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', cost: 0.002, tokens: { input: 60, output: 6 } } }),
    ].join('\n'))
    const r = await new OpenCodeExecutor(DEFAULT_CONFIG.executors.opencode, 'm').collect(nodeHost(dir, dir), dir, 0)
    assert.equal(r.ok, true)
    assert.equal(r.summary, 'final report')
    assert.ok(Math.abs((r.costUsd ?? 0) - 0.003) < 1e-9)
    assert.deepEqual(r.tokens, { input: 110, output: 11 })
  })
})

describe('parsing helpers', () => {
  it('ndjson skips garbage', () => {
    assert.deepEqual(ndjson('x\n{"a":1}\n{bad\n'), [{ a: 1 }])
  })
  it('parseVerdict rejects unknown verdicts', () => {
    assert.equal(parseVerdict('{"verdict":"maybe"}'), undefined)
    assert.equal(parseVerdict('text {"verdict":"fail","summary":"s","issues":["i"]} text')?.verdict, 'fail')
  })
})

describe('OpenRouter gateway', () => {
  it('is the default for every worker that can use it, and native for the rest', () => {
    const c = DEFAULT_CONFIG.executors
    assert.equal(DEFAULT_CONFIG.gateway, 'openrouter')
    assert.equal(c.claude.provider, 'openrouter')
    assert.equal(c.codex.provider, 'openrouter')
    assert.equal(c.opencode.provider, 'openrouter')
    assert.equal(c.cursor.provider, 'native')
    assert.equal(c.antigravity.provider, 'native')
    assert.equal(DEFAULT_CONFIG.jev.baseUrl, 'https://openrouter.ai/api')
    assert.equal(DEFAULT_CONFIG.jev.model, 'typesafe/jev-1.14')
  })

  it('picks the model of the worker\'s provider, and a per-worker override wins over the gateway', () => {
    assert.equal(modelFor(DEFAULT_CONFIG.executors.claude, 'standard'), 'anthropic/claude-sonnet-5.5')
    const native = parseConfig(JSON.stringify({ gateway: 'native' }))
    assert.equal(modelFor(native.executors.claude, 'standard'), 'sonnet')
    const mixed = parseConfig(JSON.stringify({ gateway: 'native', executors: { codex: { provider: 'openrouter' } } }))
    assert.equal(mixed.executors.codex.provider, 'openrouter')
    assert.equal(mixed.executors.claude.provider, 'native')
    assert.equal(modelFor(mixed.executors.codex, 'cheap'), 'openai/gpt-5.1-codex-mini')
  })

  it('a worker routed through OpenRouter without a key says why it cannot run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-'))
    const res = await new ClaudeExecutor(DEFAULT_CONFIG.executors.claude).available(nodeHost(dir, dir))
    assert.deepEqual(res, { ok: false, reason: 'no OPENROUTER_API_KEY in the environment' })
  })
})
