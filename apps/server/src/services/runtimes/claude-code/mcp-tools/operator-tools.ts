/**
 * Self-service & observability tools on the in-session `dorkos` MCP server
 * (DOR-430; migrated onto the Capability Registry in spec `capability-registry`,
 * task 2.2).
 *
 * Builds the same six operator tools the external `/mcp` server exposes
 * (`activity_list`, `config_get`, `check_update`, `agents_recent_activity`,
 * `update_agent`, `config_patch`) so the user's own agent inside a DorkOS
 * session can inspect and operate DorkOS. Their single source of truth is the
 * {@link operatorDomain} capability set; this function composes a registry over
 * that domain (binding the operator service handles) and projects it through the
 * generic {@link capabilityMcpTools} helper.
 *
 * @module services/runtimes/claude-code/mcp-tools/operator-tools
 */
import { logger } from '../../../../lib/logger.js';
import type { McpToolDeps } from './types.js';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { operatorDomain } from '../../../core/operator/operator-capabilities.js';
import { capabilityMcpTools } from './capability-mcp-tools.js';

/**
 * Build the operator tool definitions for the in-session `dorkos` server.
 *
 * @param deps - Shared MCP tool dependencies (mesh, runtime registry, activity).
 * @returns SDK tool definitions to spread into `createSdkMcpServer({ tools })`.
 */
export function getOperatorTools(deps: McpToolDeps) {
  const registry = composeRegistry([operatorDomain], { logger, operatorDeps: deps });
  return capabilityMcpTools(registry, 'in-session');
}
