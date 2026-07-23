/**
 * Test helper: register the marketplace domain's MCP tools against a server.
 *
 * The production `registerMarketplaceTools` glue was removed when the marketplace
 * domain migrated fully onto the Capability Registry (spec `capability-registry`,
 * task 2.3) — both MCP servers now project the whole registry in one walk. These
 * marketplace-domain tests still want to assert that JUST the marketplace domain
 * projects its eight tools, so this helper composes a registry over
 * {@link marketplaceDomain} alone and runs the same generic projection the
 * production external server uses.
 *
 * @module services/marketplace-mcp/__tests__/register-marketplace-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { composeRegistry } from '../../core/capabilities/index.js';
import { registerCapabilitiesAsMcpTools } from '../../core/external-mcp/capability-mcp-tools.js';
import { marketplaceDomain } from '../marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';

/**
 * Compose a marketplace-only registry from `deps` and register its external MCP
 * tools against `server`.
 *
 * @param server - The `McpServer` (or stub) to register tools against.
 * @param deps - The marketplace dependency bundle.
 */
export function registerMarketplaceTools(server: McpServer, deps: MarketplaceMcpDeps): void {
  const registry = composeRegistry([marketplaceDomain], {
    logger: deps.logger,
    marketplaceDeps: deps,
  });
  registerCapabilitiesAsMcpTools(server, registry, 'external');
}
