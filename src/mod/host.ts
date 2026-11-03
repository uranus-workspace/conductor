import type { EngineInterface } from 'claude-code'

import type { Host } from '../core/host.types.ts'

/**
 * The core's port, implemented with `$`. `cwd` and `home` must be real paths
 * (symlinks resolved): some workers refuse a working directory spelled through one.
 */
export function hostOf($: EngineInterface, cwd: string, home: string): Host {
  // The key: the environment first, else the system's secret store, the macOS Keychain or the
  // Secret Service on Linux (looked up once per host).
  let keychainKey: Promise<string | undefined> | undefined
  const fromKeychain = (): Promise<string | undefined> => {
    keychainKey ??= $.process
      .run(['/bin/sh', `${$.plugin.root}/scripts/openrouter-key.sh`, 'get'], { timeoutMs: 10_000 })
      .then(r => (r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined))
      .catch(() => undefined)
    return keychainKey
  }
  return {
    cwd,
    pluginRoot: $.plugin.root,
    home,
    read: async path => {
      try {
        return await $.fs.read(path)
      } catch {
        return undefined
      }
    },
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    list: async path => {
      try {
        return (await $.fs.list(path)).map(entry => entry.name)
      } catch {
        return []
      }
    },
    sleep: ms => $.clock.sleep(ms),
    run: (argv, options) => $.process.run(argv, options),
    now: () => $.clock.now(),
    fetch: (url, init) => $.http.fetch(url, init),
    openrouterKey: async () => (await $.env.get('OPENROUTER_API_KEY')) || fromKeychain(),
    mcpCall: async (server, tool, args) => {
      const res = await $.mcp.call(server, tool, args)
      const text = res.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
      return { text, isError: res.isError === true }
    },
    log: message => $.ui.log(`conductor: ${message}`, { to: 'debug' }),
  }
}

/** A path with every symlink resolved; the path itself when it cannot be resolved. */
export async function realPath($: EngineInterface, path: string): Promise<string> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}
