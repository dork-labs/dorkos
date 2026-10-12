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
import {
  scanInstallationRecords,
  type InstalledPackage,
} from '../marketplace/installed-scanner.js';

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

/** One installed package, as far as matching a recommendation needs. */
type InstalledRef = Pick<InstalledPackage, 'name' | 'type' | 'installedFrom'>;

/**
 * The packages installed where the caller would use them: the global scope,
 * plus the caller's own project when it is known. Another agent's project is
 * not scanned, so a package only that agent has does not count. `undefined`
 * when the scan failed and nothing can be said.
 *
 * @param deps - Marketplace dependency bundle; reads `dorkHome`.
 * @param projectPath - The calling session's project, when the surface knows it.
 */
async function installedInScope(
  deps: MarketplaceMcpDeps,
  projectPath: string | undefined
): Promise<readonly InstalledRef[] | undefined> {
  try {
    const records = await scanInstallationRecords(
      deps.dorkHome,
      projectPath ? { projectPath } : { agents: [] }
    );
    return records.map((record) => record.package);
  } catch (err) {
    deps.logger.warn('[marketplace_recommend] could not read installed packages', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Whether this recommended package is installed. `true` when an install has
 * its name, type and marketplace; `false` when none has its name and type, or
 * every one that does came from another marketplace. `undefined` when an
 * install with its name and type does not record where it came from, so it
 * cannot be told apart from a same-named package elsewhere — or when the scan
 * failed.
 *
 * @param installed - What {@link installedInScope} found, or `undefined`.
 * @param name - The package name.
 * @param type - The package type.
 * @param marketplace - The marketplace the recommendation came from.
 */
function installedFlag(
  installed: readonly InstalledRef[] | undefined,
  name: string,
  type: string,
  marketplace: string
): boolean | undefined {
  if (!installed) return undefined;
  const same = installed.filter((pkg) => pkg.name === name && pkg.type === type);
  if (same.some((pkg) => pkg.installedFrom === marketplace)) return true;
  if (same.some((pkg) => pkg.installedFrom === undefined)) return undefined;
  return false;
}

/** Who is asking, as far as the installed check needs. */
export interface RecommendCaller {
  /** The calling session's project directory, when the surface knows it. */
  projectPath?: string;
}

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
 * @returns An async handler function suitable for `server.tool(...)`, taking the
 *   input and, optionally, who is asking ({@link RecommendCaller}).
 */
export function createRecommendHandler(deps: MarketplaceMcpDeps) {
  return async (args: RecommendInput, caller: RecommendCaller = {}) => {
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
    const installed =
      scored.length > 0 ? await installedInScope(deps, caller.projectPath) : undefined;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              recommendations: scored.map((s) => {
                const type = s.entry.type ?? DEFAULT_PACKAGE_TYPE;
                const flag = installedFlag(installed, s.entry.name, String(type), s.marketplace);
                return {
                  name: s.entry.name,
                  type,
                  description: s.entry.description ?? '',
                  marketplace: s.marketplace,
                  relevanceScore: s.score,
                  reason: s.reason,
                  ...(flag !== undefined && { installed: flag }),
                };
              }),
            },
            null,
            2
          ),
        },
      ],
    };
  };
}
