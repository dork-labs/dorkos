/**
 * Marketplace tools on the in-session `dorkos` MCP server.
 *
 * Registers the same eight marketplace tools the external `/mcp` server
 * exposes (`marketplace_search`, `marketplace_get`,
 * `marketplace_list_marketplaces`, `marketplace_list_installed`,
 * `marketplace_recommend`, `marketplace_install`, `marketplace_uninstall`,
 * `marketplace_create_package`) so the user's own agent inside a DorkOS session
 * can browse and install packages — not only external MCP clients.
 *
 * The tool catalog and its handlers come from the transport-neutral
 * `services/marketplace-mcp/marketplace-tool-descriptors.ts`, shared with
 * `registerMarketplaceTools` (external). This module owns only the Claude Agent
 * SDK-specific glue: it maps each shared descriptor onto the SDK `tool()`
 * helper. The install/create-package confirmation-token trust boundary is
 * preserved unchanged — the same handlers gate on the same
 * {@link MarketplaceMcpDeps.confirmationProvider} regardless of transport.
 *
 * @module services/runtimes/claude-code/mcp-tools/marketplace-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';

import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { MARKETPLACE_TOOL_DESCRIPTORS } from '../../../marketplace-mcp/marketplace-tool-descriptors.js';

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
  return MARKETPLACE_TOOL_DESCRIPTORS.map((descriptor) =>
    tool(
      descriptor.name,
      descriptor.description,
      descriptor.inputSchema,
      descriptor.createHandler(deps)
    )
  );
}
