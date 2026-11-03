// Phase 3: Jira and Linear as task sources, Figma as design references, over simulated MCP servers
// built from the documented reply shapes (see docs/api-findings.md for what is confirmed).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { RuleDecisionModel } from '../../src/adapters/decision/rules.ts'
import { FigmaDesignSource, findFigmaServer, parseFigmaUrl } from '../../src/adapters/design/figma.ts'
import { ClaudeExecutor } from '../../src/adapters/executors/claude.ts'
import { findMcpServer, toolsOf } from '../../src/adapters/mcp/mcp.ts'
import { findJiraServer, JiraBoard } from '../../src/adapters/task-source/jira.ts'
import { findLinearServer, LinearBoard } from '../../src/adapters/task-source/linear.ts'
import { LocalFileTaskSource } from '../../src/adapters/task-source/local-file.ts'
import { RemoteTaskSource } from '../../src/adapters/task-source/remote-task-source.ts'
import { DEFAULT_CONFIG, parseConfig } from '../../src/core/config.ts'
import { Conductor } from '../../src/core/conductor.ts'
import type { Board } from '../../src/adapters/task-source/board.types.ts'
import type { McpFake } from '../support/node-host.ts'
import { nodeHost } from '../support/node-host.ts'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fakeClaude = join(pluginRoot, 'tests/support/fake-claude.sh')
chmodSync(fakeClaude, 0o755)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Call = { tool: string; args: Record<string, unknown> }

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-boards-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  return dir
}

/** Runs two dependent tasks to the end on a board; returns the calls the board received. */
async function runOn(makeBoard: (host: ReturnType<typeof nodeHost>) => Board, mcp: McpFake): Promise<{ calls: Call[]; conductor: Conductor; source: RemoteTaskSource; runId: string }> {
  const root = repo()
  process.env.FAKE_STATE_DIR = root
  const host = nodeHost(root, pluginRoot, { mcp })
  const config = parseConfig(JSON.stringify({ gateway: 'native', checks: ['true'], executors: { claude: { bin: fakeClaude } } }))
  const source = new RemoteTaskSource(host, new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`), makeBoard(host), true)
  const conductor = new Conductor(host, source, new RuleDecisionModel(config.riskPaths), [new ClaudeExecutor(config.executors.claude)], config,
    { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined })
  ;(conductor as unknown as { available: string[] }).available = ['claude']
  const runId = await conductor.createRun('Two files')
  await conductor.plan(runId, [
    { key: 'a', title: 'make a', description: 'create file a.txt', acceptance: ['a.txt exists'], files: ['a.txt'] },
    { key: 'b', title: 'make b', description: 'create file b.txt', acceptance: ['b.txt exists'], files: ['b.txt'], dependsOn: ['a'] },
  ])
  for (let i = 0; i < 200 && (await source.getRun(runId))?.status !== 'completed'; i++) {
    await conductor.tick(runId)
    await sleep(40)
  }
  assert.equal((await source.getRun(runId))?.status, 'completed')
  return { calls: [], conductor, source, runId }
}

describe('MCP server discovery', () => {
  const names = [
    'mcp__claude_ai_Atlassian__getAccessibleAtlassianResources', 'mcp__claude_ai_Atlassian__createJiraIssue', 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql',
    'mcp__claude_ai_Atlassian__execute', 'mcp__claude_ai_Linear__save_issue', 'mcp__claude_ai_Linear__list_issue_statuses', 'mcp__claude_ai_Linear__list_teams',
    'mcp__claude_ai_Figma__get_design_context', 'mcp__claude_ai_Figma__get_screenshot',
  ]
  it('finds each board and Figma by the tools only they have', () => {
    assert.equal(findJiraServer(names), 'claude_ai_Atlassian')
    assert.equal(findLinearServer(names), 'claude_ai_Linear')
    assert.equal(findFigmaServer(names), 'claude_ai_Figma')
    assert.equal(findMcpServer(names, ['nope']), undefined)
    assert.deepEqual([...toolsOf(names, 'claude_ai_Atlassian')].sort(), ['createJiraIssue', 'execute', 'getAccessibleAtlassianResources', 'searchJiraIssuesUsingJql'])
  })
  it('finds an older Linear server by its create/update tools', () => {
    assert.equal(findLinearServer(['mcp__lin__create_issue', 'mcp__lin__update_issue', 'mcp__lin__list_teams']), 'lin')
  })
})

describe('Jira board', () => {
  it('runs a whole run on Jira: epic, issues under it, workflow transitions by name, comments; non-primary tools through execute', async () => {
    const calls: Call[] = []
    const issues = new Map<string, { status: string; labels: string[] }>()
    let n = 0
    const direct = new Set(['getAccessibleAtlassianResources', 'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addOrEditJiraIssueComment', 'searchJiraIssuesUsingJql', 'execute'])
    const mcp: McpFake = async (_server, tool, args) => {
      calls.push({ tool, args })
      const json = (v: unknown) => ({ text: JSON.stringify(v), isError: false })
      switch (tool) {
        case 'getAccessibleAtlassianResources': return json([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }])
        case 'createJiraIssue': {
          const key = `CP-${++n}`
          issues.set(key, { status: 'To Do', labels: [] })
          return json({ key, id: String(10000 + n), self: `https://acme.atlassian.net/rest/api/3/issue/${10000 + n}` })
        }
        case 'editJiraIssue': {
          const fields = args.fields as { labels?: string[] }
          const i = issues.get(String(args.issueIdOrKey))
          if (i && fields.labels) i.labels = fields.labels
          return json({})
        }
        case 'execute': {
          const inner = String(args.name)
          if (inner === 'listJiraIssueTransitions') {
            return json({ transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '21', name: 'In Review', to: { name: 'In Review' } }, { id: '31', name: 'Done', to: { name: 'Done' } }] })
          }
          return json({ ok: true })
        }
        case 'transitionJiraIssue': {
          const names: Record<string, string> = { 11: 'In Progress', 21: 'In Review', 31: 'Done' }
          const i = issues.get(String(args.issueIdOrKey))
          if (i) i.status = names[String((args.transition as { id: string }).id)] ?? i.status
          return json({})
        }
        case 'addOrEditJiraIssueComment': return json({ id: 'c1' })
        case 'searchJiraIssuesUsingJql': return json({ issues: [] })
        default: return { text: `unknown ${tool}`, isError: true }
      }
    }
    const settings = { ...DEFAULT_CONFIG.taskSource.jira, server: 'claude_ai_Atlassian', projectKey: 'CP', site: 'acme' }
    await runOn(host => new JiraBoard(host, settings, direct), mcp)
    const by = (t: string) => calls.filter(c => c.tool === t)
    assert.ok(by('createJiraIssue').every(c => c.args.cloudId === 'cloud-1'), 'the site is found once and sent on every call')
    assert.equal(by('createJiraIssue')[0]?.args.issueType, 'Epic')
    assert.equal(by('createJiraIssue')[1]?.args.parent, 'CP-1', 'tasks go under the run epic')
    assert.ok(by('execute').some(c => c.args.name === 'listJiraIssueTransitions' && c.args.cloudId === 'cloud-1'), 'a non-primary tool goes through execute')
    assert.ok(by('execute').some(c => c.args.name === 'createJiraIssueLink'), 'the dependency becomes a link')
    assert.equal(issues.get('CP-2')?.status, 'Done')
    assert.equal(issues.get('CP-3')?.status, 'Done')
    assert.equal(issues.get('CP-1')?.status, 'Done', 'the epic closes with the run')
    assert.ok(issues.get('CP-2')?.labels.includes('conductor-merged'), 'labels carry the fine status, Jira-safe')
    assert.ok(by('addOrEditJiraIssueComment').some(c => String(c.args.commentBody).startsWith('**merged**')))
  })

  it('a missing transition leaves the status to the labels instead of failing the run', async () => {
    const logs: string[] = []
    const host = nodeHost('/tmp', pluginRoot, {
      mcp: async (_s, tool) => ({ text: JSON.stringify(tool === 'execute' ? { transitions: [] } : {}), isError: false }),
    })
    host.log = m => logs.push(m)
    const b = new JiraBoard(host, { ...DEFAULT_CONFIG.taskSource.jira, server: 'x', cloudId: 'c', projectKey: 'CP' }, new Set(['execute']))
    await b.move('CP-9', { state: 'In Review', status: 'needs_review' })
    assert.match(logs.join('\n'), /no transition to "In Review"/)
  })
})

describe('Linear board', () => {
  it('runs a whole run on Linear: project, issues with states, blockedBy, comments; labels refused → written without', async () => {
    const calls: Call[] = []
    const issues = new Map<string, { state: string }>()
    let n = 0
    let refusedLabels = 0
    const mcp: McpFake = async (_server, tool, args) => {
      calls.push({ tool, args })
      const json = (v: unknown) => ({ text: JSON.stringify(v), isError: false })
      switch (tool) {
        case 'save_project': return json({ id: 'proj-1', name: args.name })
        case 'save_issue': {
          if (args.labels !== undefined) {
            refusedLabels++
            return { text: 'Label "conductor:planned" not found', isError: true }
          }
          if (args.id === undefined) {
            const identifier = `COV-${++n}`
            issues.set(identifier, { state: String(args.state) })
            return json({ id: `uuid-${n}`, identifier, url: `https://linear.app/coverpin/issue/${identifier}` })
          }
          const i = issues.get(String(args.id))
          if (i && args.state) i.state = String(args.state)
          return json({ id: args.id, identifier: args.id })
        }
        case 'save_comment': return json({ id: 'c1' })
        case 'list_issues': return json({ issues: [], hasNextPage: false })
        default: return { text: `unknown ${tool}`, isError: true }
      }
    }
    const settings = { ...DEFAULT_CONFIG.taskSource.linear, server: 'claude_ai_Linear', team: 'COV' }
    await runOn(host => new LinearBoard(host, settings, new Set(['save_issue', 'save_project', 'save_comment', 'list_issues', 'list_teams', 'list_issue_statuses'])), mcp)
    const by = (t: string) => calls.filter(c => c.tool === t)
    assert.equal(by('save_project')[0]?.args.team, 'COV')
    assert.ok(by('save_issue').some(c => c.args.project === 'proj-1'), 'issues go in the run project')
    assert.ok(by('save_issue').some(c => Array.isArray(c.args.blockedBy) && (c.args.blockedBy as string[])[0] === 'COV-1'), 'the dependency becomes blockedBy')
    assert.equal(issues.get('COV-1')?.state, 'Done')
    assert.equal(issues.get('COV-2')?.state, 'Done')
    assert.ok(refusedLabels > 0)
    assert.ok(by('save_comment').some(c => String(c.args.body).startsWith('**merged**')))
  })
})

describe('Figma design references', () => {
  it('parses design links into fileKey and nodeId (1-2 → 1:2), branches included', () => {
    assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbC123/Checkout?node-id=12-34&t=x'), { url: 'https://www.figma.com/design/AbC123/Checkout?node-id=12-34&t=x', fileKey: 'AbC123', nodeId: '12:34' })
    assert.equal(parseFigmaUrl('https://www.figma.com/design/AbC123/branch/Br9/Checkout?node-id=1-2')?.fileKey, 'Br9')
    assert.equal(parseFigmaUrl('https://www.figma.com/file/AbC123/Old')?.nodeId, undefined)
    assert.equal(parseFigmaUrl('https://example.com/design/x'), undefined)
    assert.equal(parseFigmaUrl('not a url'), undefined)
  })

  it('fetches each link\'s design context, trimmed, and says which links failed', async () => {
    const calls: Call[] = []
    const host = nodeHost('/tmp', pluginRoot, {
      mcp: async (_s, tool, args) => {
        calls.push({ tool, args })
        return args.fileKey === 'Bad' ? { text: 'no access', isError: true } : { text: `<Checkout />${'x'.repeat(100)}`, isError: false }
      },
    })
    const src = new FigmaDesignSource(host, { server: 'figma', clientFrameworks: 'react', maxChars: 40 })
    const text = await src.context(['https://www.figma.com/design/Good/A?node-id=1-2', 'https://www.figma.com/design/Bad/B', 'https://x.com/y'])
    assert.deepEqual(calls[0]?.args, { fileKey: 'Good', nodeId: '1:2', clientFrameworks: 'react' })
    assert.match(text, /<Checkout \/>x+\n…\(trimmed\)/)
    assert.match(text, /Figma refused: no access/)
    assert.match(text, /not a Figma design link/)
  })

  it('a task with design links gets the context in its notes before it is implemented', async () => {
    const root = repo()
    process.env.FAKE_STATE_DIR = root
    const host = nodeHost(root, pluginRoot)
    const config = parseConfig(JSON.stringify({ gateway: 'native', checks: ['true'], executors: { claude: { bin: fakeClaude } } }))
    const source = new LocalFileTaskSource(host, `${root}/.conductor/tasks.json`)
    const design = { context: async (refs: readonly string[]) => `CONTEXT FOR ${refs.join(', ')}` }
    const c = new Conductor(host, source, new RuleDecisionModel([]), [new ClaudeExecutor(config.executors.claude)], config,
      { toast: () => undefined, wake: async () => undefined, summary: async () => undefined, board: async () => undefined }, design)
    ;(c as unknown as { available: string[] }).available = ['claude']
    const runId = await c.createRun('design')
    await c.plan(runId, [{ key: 'd', title: 'Checkout button', description: 'create file button.txt', acceptance: ['a'], files: ['button.txt'], designRefs: ['https://www.figma.com/design/F1/Checkout?node-id=1-2'] }])
    for (let i = 0; i < 100 && (await source.listTasks(runId))[0]?.status !== 'merged'; i++) {
      await c.tick(runId)
      await sleep(40)
    }
    const [t] = await source.listTasks(runId)
    assert.equal(t?.status, 'merged')
    assert.match(t?.notes ?? '', /## Design references\nCONTEXT FOR https:\/\/www\.figma\.com\/design\/F1/)
    const prompt = execFileSync('cat', [`${t?.attempts[0]?.logDir}/implement/prompt.md`], { encoding: 'utf8' })
    assert.match(prompt, /CONTEXT FOR/, 'the implement brief carries it')
  })
})
