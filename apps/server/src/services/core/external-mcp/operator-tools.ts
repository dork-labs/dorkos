/**
 * Self-service & observability MCP tools — external `/mcp` registration
 * (DOR-430).
 *
 * Registers the six operator tools (`activity_list`, `config_get`,
 * `check_update`, `agents_recent_activity`, `update_agent`, `config_patch`)
 * against the external `McpServer`. The catalog — names, descriptions,
 * annotations, input schemas, handler factories — lives in the transport-neutral
 * `operator/operator-tool-descriptors.ts`, shared with the in-session
 * `dorkos` server. This file owns only the `@modelcontextprotocol/sdk`-specific
 * registration glue.
 *
 * The four read-only tools carry `readOnlyHint: true` and are listed in
 * {@link READ_ONLY_MCP_TOOL_NAMES}; the two mutations (`update_agent`,
 * `config_patch`) are not — they require the local token on the login-off
 * external surface.
 *
 * @module services/core/external-mcp/operator-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { OPERATOR_TOOL_DESCRIPTORS } from '../operator/operator-tool-descriptors.js';

/**
 * Register every operator MCP tool against an existing `McpServer` instance.
 * Called from `createExternalMcpServer()` after the other tool registrations.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies threaded through every handler.
 */
export function registerOperatorTools(server: McpServer, deps: McpToolDeps): void {
  for (const descriptor of OPERATOR_TOOL_DESCRIPTORS) {
    server.registerTool(
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: descriptor.annotations,
      },
      descriptor.createHandler(deps)
    );
  }
}
