/**
 * Runtime-neutral helpers for building MCP tool-call results, shared by the
 * runtime adapters that host scoped MCP servers.
 *
 * Depends on nothing but the standard library — no runtime SDK — so it is safe
 * to import from any adapter without dragging a runtime's SDK into another's
 * module graph (ESLint confines `@anthropic-ai/claude-agent-sdk` to
 * `claude-code/` and `@openai/codex-sdk` to `codex/`).
 *
 * @module services/runtimes/shared/mcp-content
 */

/**
 * Wrap a value as an MCP JSON content result — one `text` block holding the
 * pretty-printed JSON, plus the optional `isError` flag MCP uses to mark a
 * tool-call failure.
 *
 * @param data - The payload to serialize into the text content block
 * @param isError - Set true to mark the result as a tool-call error
 */
export function jsonContent(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}
