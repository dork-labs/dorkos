/**
 * Self-service & observability tools on the in-session `dorkos` MCP server
 * (DOR-430).
 *
 * Registers the same six operator tools the external `/mcp` server exposes
 * (`activity_list`, `config_get`, `check_update`, `agents_recent_activity`,
 * `update_agent`, `config_patch`) so the user's own agent inside a DorkOS
 * session can inspect and operate DorkOS — not only external MCP clients.
 *
 * The catalog and its handlers come from the transport-neutral
 * `services/core/operator/operator-tool-descriptors.ts`, shared with
 * `registerOperatorTools` (external). This module owns only the Claude Agent
 * SDK-specific glue: it maps each shared descriptor onto the SDK `tool()` helper.
 *
 * @module services/runtimes/claude-code/mcp-tools/operator-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';

import type { McpToolDeps } from './types.js';
import { OPERATOR_TOOL_DESCRIPTORS } from '../../../core/operator/operator-tool-descriptors.js';

/**
 * Build the operator tool definitions for the in-session `dorkos` server.
 *
 * @param deps - Shared MCP tool dependencies (mesh, runtime registry, activity).
 * @returns SDK tool definitions to spread into `createSdkMcpServer({ tools })`.
 */
export function getOperatorTools(deps: McpToolDeps) {
  return OPERATOR_TOOL_DESCRIPTORS.map((descriptor) =>
    tool(
      descriptor.name,
      descriptor.description,
      descriptor.inputSchema,
      descriptor.createHandler(deps)
    )
  );
}
