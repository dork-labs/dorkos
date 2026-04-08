/**
 * `marketplace_recommend` MCP tool — recommends marketplace packages from a
 * free-text context description using keyword + tag scoring.
 *
 * Aggregates plugin entries from every enabled marketplace, optionally
 * filters by package type, scores via {@link recommend}, and returns the top
 * matches in the MCP text-content envelope. Network failures on individual
 * sources are logged and skipped — they never block recommendations from
 * other sources.
 *
 * Registered with the external MCP server by task #14
 * (`marketplace-mcp-tools.ts`) — this module deliberately exports only the
 * input schema and handler factory so parallel batch tasks can land without
 * touching the central dispatch table.
 *
 * @module services/marketplace-mcp/tool-recommend
 */
import { z } from 'zod';
import type { MarketplaceJsonEntry } from '@dorkos/marketplace';

import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';
import { recommend } from './recommend-engine.js';

/**
 * Input schema for the `marketplace_recommend` MCP tool. Exposed as a raw
 * shape (not a `z.object`) so the MCP SDK can compose it into the tool
 * registration call site at the dispatch table.
 *
 * - `context`: Free-text description of the user's need, 1-500 characters.
 * - `type`: Optional filter restricting recommendations to a single package
 *   type. Entries with no explicit `type` are treated as `plugin`.
 * - `limit`: Maximum number of recommendations to return, 1-20, default 5.
 */
export const RecommendInputSchema = {
  context: z.string().min(1).max(500).describe("Free-text description of the user's need"),
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
  limit: z.number().int().min(1).max(20).default(5),
};

/**
 * Parsed and validated input for the `marketplace_recommend` MCP tool.
 *
 * @see {@link RecommendInputSchema}
 */
export type RecommendInput = z.infer<z.ZodObject<typeof RecommendInputSchema>>;

/** Default package type assigned to entries with no explicit `type` field. */
const DEFAULT_PACKAGE_TYPE = 'plugin' as const;

/**
 * Build the `marketplace_recommend` MCP tool handler bound to the supplied
 * dependency bundle.
 *
 * The handler is a closure so the MCP SDK call site can register it without
 * threading dependencies through every invocation. All collaborators come
 * from {@link MarketplaceMcpDeps}, so this factory is trivially testable
 * with stub source manager + fetcher implementations.
 *
 * @param deps - Marketplace dependency bundle (source manager, fetcher, logger).
 * @returns An async handler function suitable for `server.tool(...)`.
 */
export function createRecommendHandler(deps: MarketplaceMcpDeps) {
  return async (args: RecommendInput) => {
    const sources = (await deps.sourceManager.list()).filter((s) => s.enabled);
    const allEntries: { entry: MarketplaceJsonEntry; marketplace: string }[] = [];

    for (const src of sources) {
      try {
        const json = await deps.fetcher.fetchMarketplaceJson(src);
        for (const entry of json.plugins) {
          if (args.type && (entry.type ?? DEFAULT_PACKAGE_TYPE) !== args.type) {
            continue;
          }
          allEntries.push({ entry, marketplace: src.name });
        }
      } catch (err) {
        deps.logger.warn('[marketplace_recommend] failed to fetch marketplace.json', {
          marketplace: src.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const scored = recommend(allEntries, args.context, args.limit);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              recommendations: scored.map((s) => ({
                name: s.entry.name,
                type: s.entry.type ?? DEFAULT_PACKAGE_TYPE,
                description: s.entry.description ?? '',
                marketplace: s.marketplace,
                relevanceScore: s.score,
                reason: s.reason,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
