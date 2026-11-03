/** An MCP tool reply, read: its text, parsed when it is JSON, and whether the server flagged an error. */
export interface McpReply {
  text: string
  isError: boolean
}
