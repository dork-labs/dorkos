/**
 * `marketplace_search` MCP tool handler.
 *
 * Aggregates `marketplace.json` entries across every configured marketplace
 * source and applies filters (type, category, tags, free-text query) before
 * returning a JSON-encoded result list. Used by the external `/mcp` server so
 * client agents (Claude Code, Cursor, etc.) can discover installable
 * DorkOS packages.
 *
 * The handler is constructed via {@link createSearchHandler} so the
 * `MarketplaceMcpDeps` bundle can be injected once at server startup. Tool
 * registration is performed by `registerMarketplaceTools()` in the
 * server-wiring task — this module never imports `McpServer`.
 *
 * @module services/marketplace-mcp/tool-search
 */
import { z } from 'zod';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Zod field map for the `marketplace_search` tool. Passed directly to
 * `server.tool(...)` as the input schema descriptor — `McpServer` wraps it in
 * a `z.object(...)` internally, so we expose both the raw shape and the
 * compiled schema for callers that need either form.
 */
export const SearchInputSchema = {
  query: z.string().optional().describe('Free-text search across name/description/tags'),
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  marketplace: z.string().optional().describe('Restrict to a specific marketplace source'),
  limit: z.number().int().min(1).max(100).default(20),
};

/**
 * Compiled Zod object schema for parsing `marketplace_search` input. Useful
 * for tests and callers that want to validate input before invoking the
 * handler directly.
 */
export const SearchInputZodSchema = z.object(SearchInputSchema);

/** Validated input for the `marketplace_search` tool. */
export type SearchInput = z.infer<typeof SearchInputZodSchema>;

/** Internal shape used while aggregating entries from multiple sources. */
type EntryWithMarketplace = MarketplaceJsonEntry & { marketplace: string };

/**
 * Build the `marketplace_search` MCP tool handler bound to a dependency
 * bundle.
 *
 * Filter ordering — applied in this exact sequence so each pass narrows the
 * working set before the next runs:
 *
 *   1. `type` (defaults missing types to `'plugin'`)
 *   2. `category` (exact match)
 *   3. `tags` (any-of match)
 *   4. `query` (case-insensitive substring across name, description, tags)
 *
 * Disabled marketplaces are skipped unless an explicit `marketplace` arg
 * names one. A failure to fetch any single marketplace is logged and the
 * search continues with the rest — fetch errors never propagate to callers.
 *
 * @param deps - Marketplace dependency bundle constructed at server startup.
 */
export function createSearchHandler(
  deps: MarketplaceMcpDeps
): (args: SearchInput) => Promise<{ content: { type: 'text'; text: string }[] }> {
  return async (args: SearchInput) => {
    const aggregated = await collectEntries(deps, args.marketplace);
    const filtered = applyFilters(aggregated, args);

    const payload = {
      results: filtered.slice(0, args.limit).map((r) => ({
        name: r.name,
        type: r.type ?? 'plugin',
        description: r.description,
        category: r.category,
        tags: r.tags,
        marketplace: r.marketplace,
        featured: r.featured,
      })),
      total: filtered.length,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  };
}

/**
 * Walk every relevant marketplace source and collect its `marketplace.json`
 * entries, tagging each entry with the source name it came from. Failures to
 * fetch a single source are logged via `deps.logger.warn` and skipped.
 */
async function collectEntries(
  deps: MarketplaceMcpDeps,
  explicitMarketplace: string | undefined
): Promise<EntryWithMarketplace[]> {
  const allSources = await deps.sourceManager.list();
  const candidates = explicitMarketplace
    ? allSources.filter((s) => s.name === explicitMarketplace)
    : allSources.filter((s) => s.enabled);

  const aggregated: EntryWithMarketplace[] = [];
  for (const source of candidates) {
    try {
      const json = await deps.fetcher.fetchMarketplaceJson(source);
      for (const entry of json.plugins) {
        aggregated.push({ ...entry, marketplace: source.name });
      }
    } catch (err) {
      deps.logger.warn('[marketplace_search] failed to fetch marketplace.json', {
        marketplace: source.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return aggregated;
}

/**
 * Apply the four filter passes (type → category → tags → query) in order.
 * Pure function — does not touch I/O — so it stays trivially testable.
 */
function applyFilters(entries: EntryWithMarketplace[], args: SearchInput): EntryWithMarketplace[] {
  let results = entries;

  if (args.type) {
    const wantedType = args.type;
    results = results.filter((r) => (r.type ?? 'plugin') === wantedType);
  }

  if (args.category) {
    const wantedCategory = args.category;
    results = results.filter((r) => r.category === wantedCategory);
  }

  if (args.tags?.length) {
    const wantedTags = args.tags;
    results = results.filter((r) => wantedTags.some((t) => r.tags?.includes(t)));
  }

  if (args.query) {
    const q = args.query.toLowerCase();
    results = results.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        (r.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }

  return results;
}
