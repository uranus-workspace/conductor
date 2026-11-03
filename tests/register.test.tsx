import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'conductor',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 1, bodyColumns: 120 },
} as const

const SUMMARY = {
  runId: 'r1', goal: 'demo', status: 'active', total: 3, merged: 1, running: 1, review: 0, failed: 0, queued: 1,
  costUsd: 0.4, tokensIn: 1_000_000, tokensOut: 200_000, budgetRunUsd: 50, budgetDayUsd: 100, spentTodayUsd: 3,
  startedAt: '2026-11-03T10:00:00.000Z', integrationBranch: 'conductor/r1/integration',
  byWorker: [{ executor: 'claude', tasks: 2, attempts: 2, tokens: 1_100_000, costUsd: 0.3, estimated: false }, { executor: 'codex', tasks: 1, attempts: 1, tokens: 100_000, costUsd: 0.1, estimated: true }],
}

/** The run's state as the engine stores it: summary and board are Shaped values, kept under their tag. */
function seed(on: (event: string, hook: (...args: never[]) => unknown) => void, summary: unknown, rows: unknown[] = []) {
  on('state.get', (_: unknown, e: unknown) => {
    const key = JSON.stringify(e)
    if (key.includes('summary')) return { value: { value: { shape: 'summary-2', value: summary }, version: 1 } }
    if (key.includes('board')) return { value: { value: { shape: 'board-2', value: rows }, version: 1 } }
    return { value: { value: null, version: 1 } }
  })
}

test('the band summarises the active run, on every surface', async ($, on) => {
  seed(on as never, SUMMARY)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const row = (await ui.find({ type: 'Text', text: /r1/ }))?.text ?? ''
    expect(row).toContain('▶ r1')
    expect(row).toContain('████▓▓▓▓░░░░')
    expect(row).toContain('1/3')
    expect(row).toContain('● 1 running')
    expect(row).toContain('1.2M tok')
    expect(row).toContain('US$ 0.40 / 50.00')
    await ui.unmount()
  }
})

test('the band shows reviews and failures, and colors the cost by budget', async ($, on) => {
  seed(on as never, { ...SUMMARY, review: 2, failed: 1, costUsd: 45 })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  const row = (await ui.find({ type: 'Text', text: /r1/ }))?.text ?? ''
  expect(row).toContain('◆ 2 review')
  expect(row).toContain('✖ 1 failed')
  expect((await ui.find({ type: 'Text', text: /^\s*US\$ 45\.00$/ }))?.props.color).toBe('warning')
  await ui.unmount()
})

test('the band turns the cost red over the run budget', async ($, on) => {
  seed(on as never, { ...SUMMARY, costUsd: 51 })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /^\s*US\$ 51\.00$/ }))?.props.color).toBe('error')
  await ui.unmount()
})

test('a narrow band drops the tokens and the budget; a taller one lists the running tasks', async ($, on) => {
  const running = { ...ROWS[0], id: 'r1-4', status: 'running', executor: 'codex', tier: 'standard', node: 'implement', runningSince: new Date(Date.now() - 65_000).toISOString() }
  seed(on as never, SUMMARY, [running])
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 50 }, surface: 'terminal' } as never)
  const row = (await narrow.find({ type: 'Text', text: /r1/ }))?.text ?? ''
  expect(row).not.toContain('tok')
  expect(row).not.toContain('/ 50.00')
  expect(row).toContain('US$ 0.40')
  await narrow.unmount()

  const tall = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 4 }, surface: 'terminal' } as never)
  const second = (await tall.find({ type: 'Text', text: /r1-4/ }))?.text ?? ''
  expect(second).toContain('● r1-4 codex/standard · implement · 1m 0')
  await tall.unmount()
})

test('the band leaves the prompt alone with no run', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('/conduct registers and answers without a run', async ($, on) => {
  const registered: string[] = []
  on('command.register', (_, e) => {
    registered.push((e as { name: string }).name)
    return { value: { command: 'conduct' } }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__conductor__${(e as { name: string }).name}` } }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['conduct'])

  const out = await $.command.run({ command: 'conduct', args: 'status' } as never)
  expect((out as { text: string }).text).toContain('no active run')
  const usage = await $.command.run({ command: 'conduct', args: 'plan' } as never)
  expect((usage as { text: string }).text).toContain('Usage: /conduct plan')
})

function engineStubs(
  on: (event: string, hook: (...args: never[]) => unknown) => void,
  sets: Array<{ key: string; value: unknown }>,
  files: Record<string, string> = {},
) {
  on('command.register', () => ({ value: { command: 'conduct' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__conductor__${e.name}` } }))
  on('fs.read', (_: unknown, e: unknown) => {
    const hit = Object.keys(files).find(name => JSON.stringify(e).includes(name))
    if (hit === undefined) throw new Error('ENOENT')
    return { value: files[hit] }
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  on('config.set', (_: unknown, e: { key: string; value: unknown }) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('/conduct off and worker switches write the settings rows', async ($, on) => {
  const sets: Array<{ key: string; value: unknown }> = []
  engineStubs(on as never, sets)
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const off = await $.command.run({ command: 'conduct', args: 'off' } as never)
  expect((off as { text: string }).text).toContain('Conductor off')
  await $.command.run({ command: 'conduct', args: 'worker cursor off' } as never)
  const bad = await $.command.run({ command: 'conduct', args: 'worker gpt off' } as never)
  expect((bad as { text: string }).text).toContain('Usage: /conduct worker')
  expect(sets).toEqual([
    { key: 'conductor.enabled', value: false },
    { key: 'conductor.worker_cursor', value: false },
  ])
})

test('switched off in settings: no plan, workers listed as off', { options: { enabled: false, worker_codex: false } }, async ($, on) => {
  engineStubs(on as never, [])
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  const plan = await $.command.run({ command: 'conduct', args: 'plan build it' } as never)
  expect((plan as { text: string }).text).toContain('switched off')

  const workers = (await $.command.run({ command: 'conduct', args: 'workers' } as never)) as { text: string }
  expect(workers.text).toContain('Conductor: off')
  expect(workers.text).toMatch(/codex\s+off in settings/)
  expect(workers.text).toMatch(/claude\s+on via openrouter · no OPENROUTER_API_KEY/)
})

const PANE = {
  plugin: 'conductor',
  component: 'Pane',
  requestId: 'conductor-board',
  props: { title: 'Conductor', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const FEATURE = ['implement', 'check', 'review', 'judge', 'merge']
const ROW = { isBusy: false, attempts: 1, tokens: 12_400, costUsd: 0.12, template: 'feature', nodes: FEATURE, dependsOn: [] }
const ROWS = [
  { ...ROW, id: 'r1-1', title: 'API schema', status: 'merged', who: 'codex/standard', executor: 'codex', tier: 'standard', note: '', nodeIndex: 5 },
  { ...ROW, id: 'r1-2', title: 'Form', status: 'needs_review', who: 'claude/strong', executor: 'claude', tier: 'strong', note: 'scope creep: 50%', worktree: '/p/.conductor/wt/r1-2-1', node: 'needs_review', nodeIndex: 3 },
  { ...ROW, id: 'r1-3', title: 'Docs', status: 'failed', who: 'openrouter/cheap', executor: 'openrouter', tier: 'cheap', note: 'OpenRouter gave no answer', node: 'failed', nodeIndex: 0, attempts: 3 },
]

test('the dashboard: progress, tiles, workers and tasks by state, with their buttons', async ($, on) => {
  seed(on as never, { ...SUMMARY, review: 1, failed: 1, running: 0, queued: 0 }, ROWS)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect((await ui.find({ type: 'Text', text: /merged$/ }))?.text).toBe('1 of 3 merged')
    expect((await ui.find({ key: 'tile-tokens' }))?.text).toContain('1.2M')
    expect((await ui.find({ key: 'tile-cost' }))?.text).toContain('of US$ 50.00')
    expect((await ui.find({ type: 'Text', text: /^codex/ }))?.text).toMatch(/1 task\(s\)\s+1 attempt\(s\)\s+100k tok\s+US\$ 0\.10 \*/)
    expect((await ui.find({ type: 'Text', text: /^Needs review/ }))?.text).toBe('Needs review (1)')
    expect((await ui.find({ type: 'Text', text: /scope creep/ }))?.text).toContain('scope creep: 50%')
    expect((await ui.find({ key: 'task-r1-3' }))?.text).toContain('attempt 3')
    expect(await ui.find({ key: 'approve-r1-2' })).toBeDefined()
    expect(await ui.find({ key: 'reject-r1-2' })).toBeDefined()
    expect(await ui.find({ key: 'retry-r1-3' })).toBeDefined()
    expect(await ui.find({ key: 'approve-r1-1' })).toBeUndefined()
    expect(await ui.find({ key: 'graph-r1-1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the dashboard draws SVG charts where the surface has Svg, text bars in the terminal', async ($, on) => {
  seed(on as never, SUMMARY, ROWS)
  // Keys are kept on Boxes and Buttons only: the charts are found by type.
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  const charts = await desktop.findAll({ type: 'Svg' })
  expect(charts.map(c => c.props.alt)).toEqual(['1 of 3 tasks merged', 'Cost by worker'])
  expect(String(charts[0]?.props.source)).toContain('1 merged')
  expect(await desktop.find({ type: 'Text', text: /^█+▓*░*$/ })).toBeUndefined()
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await terminal.find({ type: 'Text', text: /^█+▓*░+$/ }))?.text.length).toBe(78)
  await terminal.unmount()
})

test('the dashboard without a run says how to start one', async ($, on) => {
  seed(on as never, null)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /No run yet/ }))?.text).toContain('/conduct plan')
  await ui.unmount()
})

test('the maestro cannot edit a worktree while its worker runs, elsewhere it can', async ($, on) => {
  const wt = '/p/.conductor/wt/r1-1-1'
  const tasksJson = JSON.stringify({
    version: 1,
    runs: { r1: { id: 'r1', goal: 'g', createdAt: '2026-11-03T00:00:00.000Z', status: 'active' } },
    tasks: {
      'r1-1': {
        id: 'r1-1', runId: 'r1', title: 't', description: 'd', acceptance: ['a'], dependsOn: [], status: 'running',
        attempts: [{ executor: 'codex', tier: 'standard', worktree: wt, branch: 'b', baseRef: 'x', logDir: '/l', startedAt: '2026-11-03T00:00:00.000Z' }],
        job: { kind: 'implement', dir: '/l/implement', pid: 1, startedAt: '2026-11-03T00:00:00.000Z', timeoutMs: 1 },
      },
    },
    comments: {},
    updates: {},
  })
  engineStubs(on as never, [], { 'tasks.json': tasksJson })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface in tests' } }))
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: Date.parse('2026-11-03T12:00:00.000Z') }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const status = await $.command.run({ command: 'conduct', args: 'status' } as never)
  expect((status as { text: string }).text).toContain('r1-1')

  const busy = await $.tool.call({ tool: 'Write', file_path: `${wt}/src/a.ts`, content: 'x' } as never)
  expect(JSON.stringify(busy)).toContain('worktree belongs to a running task')
  const free = await $.tool.call({ tool: 'Write', file_path: '/p/src/a.ts', content: 'x' } as never)
  expect(JSON.stringify(free)).not.toContain('worktree belongs')
})

test('LGPD redaction rewrites stored rows when switched on', { options: { redact_transcript: true } }, async ($, on) => {
  const session = mock.session(on)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'CPF 529.982.247-25, token sk-or-v1-abcdefghijklmnopqrstuvwxyz' }] } } as never)
  const text = JSON.stringify(session.appended().at(-1)?.message)
  expect(text).toContain('[CPF]')
  expect(text).not.toContain('529.982.247-25')
  expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
})

test('LGPD redaction leaves rows alone when off', async ($, on) => {
  const session = mock.session(on)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'CPF 529.982.247-25' }] } } as never)
  expect(JSON.stringify(session.appended().at(-1)?.message)).toContain('529.982.247-25')
})

test('LGPD redaction masks the typed prompt before it is recorded', { options: { redact_transcript: true } }, async ($, on) => {
  const seen: string[] = []
  on('prompt.submit', (_, e) => {
    const text = (e as { text: string }).text
    seen.push(text)
    return { text }
  })
  await $.prompt.submit({ text: 'cliente CNPJ 11.222.333/0001-81' } as never)
  expect(seen.at(-1)).toBe('cliente CNPJ [CNPJ]')
})

test('the graph pane draws the template and the path taken', async ($, on) => {
  const graph = { taskId: 'r1-1', mermaid: 'flowchart LR\n  implement --> check', path: 'r1-1 · feature v1 · at merge\nimplement (ok) → check: diff' }
  on('state.get', (_, e) => ({ value: { value: JSON.stringify(e).includes('graph') ? graph : null, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, requestId: 'conductor-graph', surface } as never)
    expect((await ui.find({ type: 'Text', text: /feature v1/ }))?.text).toContain('at merge')
    expect((await ui.find({ key: 'graph-mermaid' }))?.text).toContain('implement --> check')
    await ui.unmount()
  }
})

test('the Graph button on the dashboard draws that task\'s graph', async ($, on) => {
  const tasksJson = JSON.stringify({
    version: 1,
    runs: { r1: { id: 'r1', goal: 'g', createdAt: '2026-11-03T00:00:00.000Z', status: 'active' } },
    tasks: {
      'r1-1': {
        id: 'r1-1', runId: 'r1', title: 't', description: 'd', acceptance: ['a'], dependsOn: [], status: 'verifying',
        template: 'feature', cursor: 'check', attempts: [],
      },
    },
    comments: {},
    updates: {},
  })
  const writes: string[] = []
  engineStubs(on as never, [], { 'tasks.json': tasksJson })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_, e) => {
    writes.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface in tests' } }))
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: Date.parse('2026-11-03T12:00:00.000Z') }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const status = await $.command.run({ command: 'conduct', args: 'status' } as never)
  expect((status as { text: string }).text).toContain('r1-1')

  const dash = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  await dash.press({ key: 'graph-r1-1' })
  const graph = await $.ui.mount({ ...PANE, requestId: 'conductor-graph', surface: 'terminal' } as never)
  let path: string | undefined
  for (let i = 0; i < 50 && path === undefined; i++) path = (await graph.find({ type: 'Text', text: /feature v/ }))?.text
  expect(path).toContain('r1-1 · feature v')
  expect(writes.some(w => w.includes('graphs/r1-1.mmd'))).toBe(true)
  await graph.unmount()
  await dash.unmount()
})
