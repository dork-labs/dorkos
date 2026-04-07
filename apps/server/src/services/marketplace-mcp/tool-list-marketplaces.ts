/**
 * Handler factory for the `marketplace_list_marketplaces` MCP tool.
 *
 * Returns every configured marketplace source from `MarketplaceSourceManager`
 * — both enabled and disabled — augmented with the package count derived
 * from each source's `marketplace.json#plugins.length`. Counts are best
 * effort: a fetch failure for one source falls back to `packageCount: 0`
 * and logs a warning rather than failing the entire call.
 *
 * The actual `server.tool(...)` registration is performed by the phase-4
 * server-wiring task (#14) which imports this factory alongside its
 * siblings. This file deliberately exports only the handler so parallel
 * Phase 2/3 batches do not need to touch `marketplace-mcp-tools.ts`.
 *
 * @module services/marketplace-mcp/tool-list-marketplaces
 */
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Shape of a single source row in the `marketplace_list_marketplaces`
 * response payload. Mirrors the configured `MarketplaceSource` plus the
 * computed `packageCount`.
 */
interface ListedMarketplace {
  /** User-chosen identifier (e.g., "dorkos-community"). */
  name: string;
  /** Git URL, marketplace JSON URL, or `file://` path. */
  source: string;
  /** Whether the source is currently enabled. */
  enabled: boolean;
  /** Number of plugin entries in the source's `marketplace.json` (0 on error). */
  packageCount: number;
}

/**
 * Build the `marketplace_list_marketplaces` tool handler bound to the
 * given dependency bundle. The returned async function takes no input,
 * lists every configured source, fetches each source's `marketplace.json`
 * to count plugins, and returns the result as a JSON-encoded MCP text
 * block.
 *
 * The return type is intentionally inferred so the MCP SDK's loose
 * `CallToolResult` shape (with its index signature) accepts it without an
 * explicit cast at the registration site in `marketplace-mcp-tools.ts`.
 *
 * @param deps - Marketplace MCP dependency bundle.
 * @returns An MCP tool handler with empty input schema.
 */
export function createListMarketplacesHandler(deps: MarketplaceMcpDeps) {
  return async () => {
    const sources = await deps.sourceManager.list();
    const enriched: ListedMarketplace[] = await Promise.all(
      sources.map(async (src) => {
        let packageCount = 0;
        try {
          const json = await deps.fetcher.fetchMarketplaceJson(src);
          packageCount = json.plugins.length;
        } catch (err) {
          deps.logger.warn('[marketplace_list_marketplaces] failed to count packages', {
            marketplace: src.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return {
          name: src.name,
          source: src.source,
          enabled: src.enabled,
          packageCount,
        };
      })
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ sources: enriched }, null, 2),
        },
      ],
    };
  };
}
