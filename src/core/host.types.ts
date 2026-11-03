export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export interface HttpResult {
  status: number
  ok: boolean
  text: string
}

export interface Host {
  /** Absolute path of the project the session runs in. */
  cwd: string
  /** Absolute path of the plugin folder (scripts, schemas). */
  pluginRoot: string
  /** The user's home directory (worktrees live under it, outside the project). */
  home: string
  read(path: string): Promise<string | undefined>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Names of a directory's entries; [] when it does not exist. */
  list(path: string): Promise<string[]>
  sleep(ms: number): Promise<void>
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  now(): Promise<number>
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResult>
  openrouterKey(): Promise<string | undefined>
  /** Calls a tool on one of the session's MCP servers (Uranus OS); its text blocks joined. */
  mcpCall(server: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  log(message: string): void
}
