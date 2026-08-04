/**
 * TanStack Query key factory for agent identity queries.
 *
 * @module entities/agent/api
 */
export const agentKeys = {
  all: ['agents'] as const,
  byPath: (path: string) => ['agents', 'byPath', path] as const,
  resolved: (paths: string[]) => ['agents', 'resolved', ...paths] as const,
  /** An agent's DorkOS-managed MCP servers (spec `mcp-server-management`). */
  mcpServers: (agentId: string) => ['agents', 'mcp-servers', agentId] as const,
};
