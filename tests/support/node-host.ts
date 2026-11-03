// A Host over Node's own APIs, for tests outside the mod engine.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { Host, RunResult } from '../../src/core/host.types.ts'

export type McpFake = (server: string, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>

export function nodeHost(
  cwd: string,
  pluginRoot: string,
  opts: { now?: () => number; openrouterKey?: string; fetch?: Host['fetch']; mcp?: McpFake; home?: string } = {},
): Host & { logs: string[] } {
  const logs: string[] = []
  // Real paths, as the mod resolves them: some workers (agy) refuse a cwd spelled through a symlink (/var -> /private/var).
  const home = opts.home ?? `${tmpdir()}/conductor-test-home`
  mkdirSync(home, { recursive: true })
  return {
    cwd: realpathSync(cwd),
    pluginRoot,
    // Tests keep worktrees out of the real home folder.
    home: realpathSync(home),
    logs,
    read: async path => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return undefined
      }
    },
    write: async (path, text) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    exists: async path => existsSync(path),
    list: async path => {
      try {
        return await readdir(path)
      } catch {
        return []
      }
    },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    run: (argv, options) =>
      new Promise<RunResult>(resolve => {
        const [cmd, ...args] = argv
        const child = execFile(
          cmd as string,
          args,
          { cwd: options?.cwd ?? cwd, env: { ...process.env, ...options?.env }, timeout: options?.timeoutMs ?? 30_000 },
          (err, stdout, stderr) => {
            const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
            resolve({ exitCode: code, stdout, stderr })
          },
        )
        if (options?.stdin !== undefined) child.stdin?.end(options.stdin)
        else child.stdin?.end()
      }),
    now: async () => (opts.now ?? Date.now)(),
    fetch: opts.fetch ?? (async () => ({ status: 599, ok: false, text: 'network disabled in tests' })),
    openrouterKey: async () => opts.openrouterKey,
    mcpCall: opts.mcp ?? (async () => ({ text: 'no MCP in tests', isError: true })),
    log: message => logs.push(message),
  }
}
