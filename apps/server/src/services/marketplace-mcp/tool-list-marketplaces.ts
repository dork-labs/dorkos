/**
 * Handler factory for the `marketplace_list_marketplaces` MCP tool.
 *
 * Returns every configured marketplace source from `MarketplaceSourceManager`
 * — both enabled and disabled — augmented with the package count derived
 * from each source's `marketplace.json#plugins.length`. Counts are best
 * effort: a fetch failure for one source falls back to `packageCount: 0`
 * and logs a warning rather than failing the entire call. Each row also
 * carries `lastFetch`, which says whether that 0 is an empty marketplace or a
 * listing that didn't load (DOR-2324).
 *
 * The actual `server.tool(...)` registration is performed by the phase-4
 * server-wiring task (#14) which imports this factory alongside its
 * siblings. This file deliberately exports only the handler so parallel
 * Phase 2/3 batches do not need to touch `marketplace-mcp-tools.ts`.
 *
 * @module services/marketplace-mcp/tool-list-marketplaces
 */
import type { SourceLastFetch } from '@dorkos/shared/marketplace-schemas';
import type { PageQuery } from '@dorkos/shared/paging';
import { describeLastFetch } from '../marketplace/sources/source-listing.js';
import { invalidCursor } from '../core/capabilities/capability-definition.js';
import { assertPageCursor, pageInOwnOrder } from '../../lib/paging/keyset-page.js';
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
  /**
   * How the most recent fetch of the listing went (DOR-2324) — including the
   * one this call just made. It is what tells an empty marketplace (`fetched`,
   * 0 packages) from one whose listing didn't load (`failed`, with a reason).
   */
  lastFetch: SourceLastFetch;
}

/**
 * Build the `marketplace_list_marketplaces` tool handler bound to the
 * given dependency bundle. The returned async function takes a page
 * query, lists one page of configured sources in the sources file's order
 * (the cursor is the same as `GET /api/marketplace/sources` gives, DOR-4982),
 * fetches each listed source's `marketplace.json` to count plugins, and
 * returns the page and its `nextCursor` as a JSON-encoded MCP text block.
 *
 * The return type is intentionally inferred so the MCP SDK's loose
 * `CallToolResult` shape (with its index signature) accepts it without an
 * explicit cast at the registration site in `marketplace-mcp-tools.ts`.
 *
 * @param deps - Marketplace MCP dependency bundle.
 * @returns An MCP tool handler taking `cursor` and `limit`.
 */
export function createListMarketplacesHandler(deps: MarketplaceMcpDeps) {
  return async (query: PageQuery) => {
    assertPageCursor('sources', query.cursor, invalidCursor);
    const sources = await deps.sourceManager.list();
    const page = pageInOwnOrder('sources', sources, (src) => src.name, query, invalidCursor);
    const enriched: ListedMarketplace[] = await Promise.all(
      page.items.map(async (src) => {
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
          lastFetch: await describeLastFetch(deps.cache, src.name),
        };
      })
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ sources: enriched, nextCursor: page.nextCursor }, null, 2),
        },
      ],
    };
  };
}
