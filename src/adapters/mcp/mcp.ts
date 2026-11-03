// Remote MCP servers the Conductor talks to through the session's own connections ($.mcp.call):
// finding a server by the tools only it has, and reading its replies field by field.
import { isJsonObject, stringAt, tryParse } from '../../core/json.ts'
import type { JsonObject } from '../../core/json.types.ts'

/**
 * The server segment of `mcp__<server>__<tool>` for the server exposing every tool of
 * `signature`; undefined when none does. `$.mcp.call` accepts that tool-name spelling,
 * so a connector's display name (which differs per install) is never needed.
 */
export function findMcpServer(toolNames: readonly string[], signature: readonly string[]): string | undefined {
  const byServer = new Map<string, Set<string>>()
  for (const name of toolNames) {
    const m = /^mcp__(.+)__([^_].*)$/.exec(name)
    if (!m) continue
    const server = m[1]
    const tool = m[2]
    if (server === undefined || tool === undefined) continue
    const tools = byServer.get(server) ?? new Set<string>()
    tools.add(tool)
    byServer.set(server, tools)
  }
  for (const [server, tools] of byServer) if (signature.every(t => tools.has(t))) return server
  return undefined
}

/** The tools a server exposes directly, from the session's tool names. */
export function toolsOf(toolNames: readonly string[], server: string): Set<string> {
  const prefix = `mcp__${server}__`
  return new Set(toolNames.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length)))
}

/**
 * A reply as an object: a JSON object as is (its `data` when it is an envelope), a JSON
 * array as `{ items }`, anything else as `{ text }`.
 */
export function replyObject(text: string): JsonObject {
  const v = tryParse(text)
  if (isJsonObject(v)) return isJsonObject(v.data) ? v.data : v
  if (Array.isArray(v)) return { items: v }
  return { text }
}

/** The first string under any of `fields`, in the object or one level down. */
export function findString(o: JsonObject, fields: readonly string[]): string | undefined {
  for (const f of fields) {
    const v = stringAt(o, f)
    if (v) return v
  }
  for (const nested of Object.values(o).filter(isJsonObject)) {
    for (const f of fields) {
      const v = stringAt(nested, f)
      if (v) return v
    }
  }
  return undefined
}
