import type { DesignSource } from '../../core/conductor.types.ts'
import type { FigmaSettings } from '../../core/config.types.ts'
import type { Host } from '../../core/host.types.ts'
import type { JsonObject } from '../../core/json.types.ts'
import { findMcpServer } from '../mcp/mcp.ts'
import type { FigmaRef } from './figma.types.ts'

export class FigmaError extends Error {}

/** The Figma MCP server's tools: how `auto` recognises it. */
export const FIGMA_SIGNATURE: readonly string[] = ['get_design_context']

export const findFigmaServer = (toolNames: readonly string[]): string | undefined => findMcpServer(toolNames, FIGMA_SIGNATURE)

/**
 * `https://www.figma.com/design/:fileKey/:name?node-id=1-2` → `{ fileKey, nodeId: '1:2' }`.
 * A branch link (`/design/:fileKey/branch/:branchKey/…`) addresses the branch. Not a Figma
 * design or file link → undefined.
 */
export function parseFigmaUrl(url: string): FigmaRef | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return undefined
  const parts = u.pathname.split('/').filter(Boolean)
  const kind = parts[0]
  if (kind !== 'design' && kind !== 'file' && kind !== 'proto' && kind !== 'board') return undefined
  const branch = parts[2] === 'branch' ? parts[3] : undefined
  const fileKey = branch ?? parts[1]
  if (!fileKey) return undefined
  const node = u.searchParams.get('node-id')
  return { url, fileKey, nodeId: node ? node.replace(/-/g, ':') : undefined }
}

/**
 * Design references through the Figma MCP server: each link's design context (the
 * generated code, the assets and the variables it uses), trimmed, as Markdown the
 * research and implement nodes read.
 */
export class FigmaDesignSource implements DesignSource {
  private readonly host: Host
  private readonly config: FigmaSettings

  constructor(host: Host, config: FigmaSettings) {
    this.host = host
    this.config = config
  }

  async context(refs: readonly string[]): Promise<string> {
    const parts: string[] = []
    for (const url of refs) {
      const ref = parseFigmaUrl(url)
      if (ref === undefined) {
        parts.push(`### ${url}\n(not a Figma design link)`)
        continue
      }
      const args: JsonObject = { fileKey: ref.fileKey, ...(ref.nodeId ? { nodeId: ref.nodeId } : {}), ...(this.config.clientFrameworks ? { clientFrameworks: this.config.clientFrameworks } : {}) }
      const res = await this.host.mcpCall(this.config.server, 'get_design_context', args)
      if (res.isError) {
        parts.push(`### ${url}\n(Figma refused: ${res.text.slice(0, 200)})`)
        continue
      }
      const text = res.text.length > this.config.maxChars ? `${res.text.slice(0, this.config.maxChars)}\n…(trimmed)` : res.text
      parts.push(`### ${url}\n${text}`)
    }
    return parts.join('\n\n')
  }
}
