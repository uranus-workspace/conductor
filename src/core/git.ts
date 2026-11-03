import type { MergeOutcome } from './git.types.ts'
import type { Host, RunResult } from './host.types.ts'

export class GitError extends Error {}

async function git(host: Host, cwd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return host.run(['git', ...args], { cwd, timeoutMs })
}

async function gitOk(host: Host, cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const out = await git(host, cwd, args, timeoutMs)
  if (out.exitCode !== 0) throw new GitError(`git ${args.join(' ')}: ${out.stderr.trim() || out.stdout.trim()}`)
  return out.stdout.trim()
}

export const integrationBranch = (runId: string) => `conductor/${runId}/integration`
export const taskBranch = (runId: string, taskId: string, attempt: number) => `conductor/${runId}/${taskId}-${attempt}`

/** A short, stable hash of the project path: two checkouts named alike get their own worktree folders. */
export function pathHash(path: string): string {
  let h = 2166136261
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

/**
 * Where a project's worktrees live: outside the project. Nested inside it they sit
 * under a git-ignored folder of the parent repository, and some workers (Antigravity)
 * refuse to write there; tools that walk up for config would also find the parent's.
 */
export function worktreeRoot(root: string, home: string, configured: string): string {
  if (configured !== '') return configured
  const name = root.split('/').filter(Boolean).at(-1) ?? 'project'
  return `${home}/.conductor/worktrees/${name}-${pathHash(root)}`
}

export function paths(root: string, runId: string, wtRoot: string) {
  return {
    dir: `${root}/.conductor`,
    integration: `${wtRoot}/${runId}/integration`,
    worktree: (taskId: string, attempt: number) => `${wtRoot}/${runId}/${taskId}-${attempt}`,
    logs: (taskId: string, attempt: number) => `${root}/.conductor/logs/${runId}/${taskId}/${attempt}`,
  }
}

/** Keeps `.conductor/` out of the project's status without touching its .gitignore. */
export async function excludeConductorDir(host: Host, root: string): Promise<void> {
  const gitDir = await gitOk(host, root, ['rev-parse', '--git-common-dir'])
  const exclude = `${gitDir.startsWith('/') ? gitDir : `${root}/${gitDir}`}/info/exclude`
  const text = (await host.read(exclude)) ?? ''
  if (!text.split('\n').includes('.conductor/')) {
    await host.write(exclude, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}.conductor/\n`)
  }
}

/** Creates the run's integration branch at HEAD and checks it out in its own worktree. */
export async function ensureIntegration(host: Host, root: string, runId: string, wtRoot: string): Promise<{ branch: string; baseRef: string }> {
  const branch = integrationBranch(runId)
  const { integration } = paths(root, runId, wtRoot)
  const baseRef = await gitOk(host, root, ['rev-parse', 'HEAD'])
  if (!(await host.exists(integration))) {
    const known = await git(host, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    const args = known.exitCode === 0 ? ['worktree', 'add', integration, branch] : ['worktree', 'add', '-b', branch, integration, baseRef]
    await gitOk(host, root, args)
  }
  return { branch, baseRef }
}

export async function addWorktree(host: Host, root: string, path: string, branch: string, from: string): Promise<void> {
  if (await host.exists(path)) await gitOk(host, root, ['worktree', 'remove', '--force', path])
  await gitOk(host, root, ['worktree', 'add', '-B', branch, path, from])
}

export async function removeWorktree(host: Host, root: string, path: string): Promise<void> {
  if (await host.exists(path)) await git(host, root, ['worktree', 'remove', '--force', path])
}

/** Commits whatever the worker left; returns the files changed against `base`. */
export async function commitAll(host: Host, worktree: string, message: string, base: string): Promise<{ changedFiles: string[]; diffStat: string }> {
  await gitOk(host, worktree, ['add', '-A'])
  const staged = await git(host, worktree, ['diff', '--cached', '--quiet'])
  if (staged.exitCode !== 0) {
    await gitOk(host, worktree, ['-c', 'user.name=Conductor', '-c', 'user.email=conductor@localhost', 'commit', '-q', '--no-verify', '-m', message])
  }
  const names = await gitOk(host, worktree, ['diff', '--name-only', `${base}...HEAD`])
  const diffStat = await gitOk(host, worktree, ['diff', '--shortstat', `${base}...HEAD`])
  return { changedFiles: names === '' ? [] : names.split('\n'), diffStat }
}


/** One merge at a time (the caller holds the lock); a conflict is aborted and handed to the maestro. */
export async function mergeInto(host: Host, integrationPath: string, branch: string, message: string): Promise<MergeOutcome> {
  const out = await git(host, integrationPath, [
    '-c', 'user.name=Conductor', '-c', 'user.email=conductor@localhost',
    'merge', '--no-ff', '--no-edit', '-m', message, branch,
  ])
  if (out.exitCode === 0) return { ok: true }
  const conflicted = await git(host, integrationPath, ['diff', '--name-only', '--diff-filter=U'])
  await git(host, integrationPath, ['merge', '--abort'])
  return { ok: false, conflict: conflicted.stdout.trim() || out.stdout.trim() || out.stderr.trim() }
}

export async function headOf(host: Host, cwd: string): Promise<string> {
  return gitOk(host, cwd, ['rev-parse', 'HEAD'])
}
