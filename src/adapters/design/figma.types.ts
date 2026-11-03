/** A Figma design link, as the Figma MCP server addresses it. */
export interface FigmaRef {
  url: string
  fileKey: string
  /** `1:2` form; undefined for a whole file. */
  nodeId?: string
}
