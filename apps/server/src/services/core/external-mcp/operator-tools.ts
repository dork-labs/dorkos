/**
 * Self-service & observability MCP tools — external `/mcp` registration
 * (DOR-430; migrated onto the Capability Registry in spec `capability-registry`,
 * task 2.2).
 *
 * Registers the six operator tools (`activity_list`, `config_get`,
 * `check_update`, `agents_recent_activity`, `update_agent`, `config_patch`)
 * against the external `McpServer`. Their single source of truth is the
 * {@link operatorDomain} capability set; this function composes a registry over
 * that domain (binding the operator service handles) and hands it to the
 * generic {@link registerCapabilitiesAsMcpTools} walk. Annotations and the
 * read-only carve-out are derived from each capability's tier and surface flags.
 *
 * @module services/core/external-mcp/operator-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { logger } from '../../../lib/logger.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { composeRegistry } from '../capabilities/index.js';
import { operatorDomain } from '../operator/operator-capabilities.js';
import { registerCapabilitiesAsMcpTools } from './capability-mcp-tools.js';

/**
 * Register every operator MCP tool against an existing `McpServer` instance.
 * Called from `createExternalMcpServer()` after the other tool registrations.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies threaded through every handler.
 */
export function registerOperatorTools(server: McpServer, deps: McpToolDeps): void {
  const registry = composeRegistry([operatorDomain], { logger, operatorDeps: deps });
  registerCapabilitiesAsMcpTools(server, registry, 'external');
}
