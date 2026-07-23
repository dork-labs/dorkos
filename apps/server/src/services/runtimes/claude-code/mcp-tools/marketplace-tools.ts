/**
 * Marketplace tools on the in-session `dorkos` MCP server (migrated onto the
 * Capability Registry in spec `capability-registry`, task 2.2).
 *
 * Builds the same eight marketplace tools the external `/mcp` server exposes
 * (`marketplace_search`, `marketplace_get`, `marketplace_list_marketplaces`,
 * `marketplace_list_installed`, `marketplace_recommend`, `marketplace_install`,
 * `marketplace_uninstall`, `marketplace_create_package`) so the user's own agent
 * inside a DorkOS session can browse and install packages. Their single source
 * of truth is the {@link marketplaceDomain} capability set; this function
 * composes a registry over that domain (binding the marketplace dependency
 * bundle) and projects it through the generic {@link capabilityMcpTools} helper.
 * The install/create-package confirmation-token trust boundary is preserved
 * unchanged — the same handlers gate on the same
 * {@link MarketplaceMcpDeps.confirmationProvider} regardless of transport.
 *
 * @module services/runtimes/claude-code/mcp-tools/marketplace-tools
 */
import { composeRegistry } from '../../../core/capabilities/index.js';
import { marketplaceDomain } from '../../../marketplace-mcp/marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { capabilityMcpTools } from './capability-mcp-tools.js';

/**
 * Build the marketplace tool definitions for the in-session `dorkos` server.
 *
 * Returns an empty array when the marketplace surface is not wired (relay
 * disabled, or the deps bundle has not been constructed yet) so the in-session
 * server simply omits these tools rather than registering broken handlers.
 *
 * @param deps - The marketplace dependency bundle, or `undefined` when the
 *   marketplace surface is unavailable in this instance.
 * @returns SDK tool definitions to spread into `createSdkMcpServer({ tools })`.
 */
export function getMarketplaceTools(deps: MarketplaceMcpDeps | undefined) {
  if (!deps) return [];
  const registry = composeRegistry([marketplaceDomain], {
    logger: deps.logger,
    marketplaceDeps: deps,
  });
  return capabilityMcpTools(registry, 'in-session');
}
