import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'conductor',
  component: 'AbovePrompt',
  props: { hasSurvey: false, bodyColumns: 80 },
} as const

const SUMMARY = {
  runId: 'r1', goal: 'demo', status: 'active', total: 3, merged: 1, running: 1, review: 0, failed: 0, costUsd: 0.4,
}

test('the band summarises the active run, on every surface', async ($, on) => {
  on('state.get', () => ({ value: { value: SUMMARY, version: 1 } }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const row = await ui.find({ type: 'Text', text: /r1/ })
    expect(row?.text).toBe('▶ r1 1/3 · 1 running · US$ 0.40')
    await ui.unmount()
  }
})

test('the band shows reviews and failures', async ($, on) => {
  on('state.get', () => ({ value: { value: { ...SUMMARY, review: 2, failed: 1 }, version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /r1/ }))?.text).toBe('▶ r1 1/3 · 1 running · 2 review · 1 failed · US$ 0.40')
  await ui.unmount()
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

const ROWS = [
  { id: 'r1-1', title: 'API schema', status: 'merged', who: 'codex/standard', note: '', isBusy: false },
  { id: 'r1-2', title: 'Form', status: 'needs_review', who: 'claude/strong', note: 'scope creep: 50%', worktree: '/p/.conductor/wt/r1-2-1', isBusy: false },
  { id: 'r1-3', title: 'Docs', status: 'failed', who: 'openrouter/cheap', note: 'OpenRouter gave no answer', isBusy: false },
]

test('the board pane lists tasks with review and retry buttons', async ($, on) => {
  // The board is a Shaped value: a stored row list counts only under its tag.
  on('state.get', (_, e) => ({ value: JSON.stringify(e).includes('board') ? { value: { shape: 'board-1', value: ROWS }, version: 1 } : { value: null, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect((await ui.find({ type: 'Text', text: /scope creep/ }))?.text).toContain('scope creep: 50%')
    expect(await ui.find({ key: 'approve-r1-2' })).toBeDefined()
    expect(await ui.find({ key: 'retry-r1-3' })).toBeDefined()
    expect(await ui.find({ key: 'approve-r1-1' })).toBeUndefined()
    await ui.unmount()
  }
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
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'conduct', args: 'status' } as never)

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
