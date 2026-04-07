/**
 * `marketplace_get` MCP tool — fetch full details for a single marketplace
 * package by name, including the parsed manifest and the README rendered from
 * the source repository.
 *
 * The handler walks every enabled marketplace (or the explicit one supplied by
 * the caller) until it finds a `marketplace.json` entry whose `name` matches.
 * It then runs the package through `installer.preview()` so the agent gets the
 * fully validated `MarketplacePackageManifest` rather than the abbreviated
 * `marketplace.json` summary. README content is best-effort: a missing
 * `README.md` returns `undefined` instead of failing the request.
 *
 * Tool registration is intentionally NOT performed in this file. Phase-4 task
 * #14 collects every handler and `server.tool(...)` call into
 * {@link ./marketplace-mcp-tools.ts} in a single coordinated edit so parallel
 * batches do not collide on that file.
 *
 * @module services/marketplace-mcp/tool-get
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { MarketplaceJsonEntry, MarketplacePackageManifest } from '@dorkos/marketplace';
import type { MarketplaceSource } from '../marketplace/types.js';
import type { MarketplaceMcpDeps } from './marketplace-mcp-tools.js';

/**
 * Zod input shape for `marketplace_get`. Exported as a plain object so the
 * phase-4 wiring task can hand it directly to `server.tool(name, desc, shape,
 * handler)` without any extra adapter glue.
 */
export const GetInputSchema = {
  name: z.string().describe('Package name'),
  marketplace: z.string().optional().describe('Specific marketplace to look up the package in'),
};

/** Inferred input type for {@link createGetHandler}. */
export type GetInput = { name: string; marketplace?: string };

/**
 * Discriminated content shape returned by every marketplace MCP tool. Mirrors
 * the `@modelcontextprotocol/sdk` `CallToolResult` so the phase-4 wiring task
 * can return the value verbatim from `server.tool(...)`.
 */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Internal record of the located marketplace.json entry plus its source name. */
interface LocatedEntry {
  entry: MarketplaceJsonEntry;
  marketplaceName: string;
}

/**
 * Build a `marketplace_get` handler bound to the supplied dependency bundle.
 *
 * The returned async function:
 * 1. Lists configured marketplaces and filters to either the explicit
 *    `args.marketplace` (if provided) or every `enabled: true` source.
 * 2. Walks the candidates calling `fetcher.fetchMarketplaceJson(src)` until it
 *    finds a `plugins[]` entry whose `name === args.name`.
 *    Per-source fetch failures are logged via `logger.warn` and skipped — one
 *    broken marketplace must not poison the lookup.
 * 3. On a miss, returns `{ isError: true, content: [{ error, code:
 *    'PACKAGE_NOT_FOUND' }] }`.
 * 4. On a hit, calls `installer.preview()` to obtain the fully validated
 *    `MarketplacePackageManifest`, then best-effort reads `README.md` from the
 *    staged package path. If `preview()` throws, the handler logs a warning
 *    and falls back to the marketplace.json entry alone (manifest=null,
 *    readme=undefined). The agent still gets every catalog field; only the
 *    deeper manifest details are missing.
 *
 * @param deps - Marketplace dependency bundle constructed at server startup.
 * @returns An async tool handler suitable for `server.tool(...)` registration.
 */
export function createGetHandler(deps: MarketplaceMcpDeps) {
  return async (args: GetInput): Promise<ToolResult> => {
    const located = await locateEntry(deps, args);

    if (!located) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: `Package '${args.name}' not found`,
                code: 'PACKAGE_NOT_FOUND',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    const { manifest, readme } = await loadManifestAndReadme(deps, located, args.name);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              package: {
                name: located.entry.name,
                type: located.entry.type ?? 'plugin',
                description: located.entry.description,
                category: located.entry.category,
                tags: located.entry.tags,
                marketplace: located.marketplaceName,
                manifest,
                readme,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  };
}

/**
 * Walk the configured marketplace sources looking for an entry whose name
 * matches `args.name`. Honors `args.marketplace` (exact match) when supplied,
 * otherwise filters to enabled sources only.
 *
 * Per-source fetch failures are logged and skipped so one broken marketplace
 * cannot block lookups in healthy ones.
 *
 * @internal
 */
async function locateEntry(deps: MarketplaceMcpDeps, args: GetInput): Promise<LocatedEntry | null> {
  const sources = await deps.sourceManager.list();
  const candidates = filterCandidates(sources, args.marketplace);

  for (const src of candidates) {
    try {
      const json = await deps.fetcher.fetchMarketplaceJson(src);
      const found = json.plugins.find((p) => p.name === args.name);
      if (found) {
        return { entry: found, marketplaceName: src.name };
      }
    } catch (err) {
      deps.logger.warn('[marketplace_get] failed to fetch marketplace.json', {
        marketplace: src.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return null;
}

/**
 * Resolve the candidate source list for a get lookup. With an explicit
 * marketplace name, the result is at most one source (exact match by name);
 * without one, the result is every enabled source.
 *
 * @internal
 */
function filterCandidates(
  sources: MarketplaceSource[],
  explicitMarketplace: string | undefined
): MarketplaceSource[] {
  if (explicitMarketplace) {
    return sources.filter((s) => s.name === explicitMarketplace);
  }
  return sources.filter((s) => s.enabled);
}

/**
 * Run `installer.preview()` for the located entry and read its README. Failure
 * is non-fatal: a `preview()` throw or a missing README returns `null`/
 * `undefined` so the caller can still surface the marketplace.json entry to
 * the agent.
 *
 * @internal
 */
async function loadManifestAndReadme(
  deps: MarketplaceMcpDeps,
  located: LocatedEntry,
  packageName: string
): Promise<{ manifest: MarketplacePackageManifest | null; readme: string | undefined }> {
  try {
    const previewResult = await deps.installer.preview({
      name: packageName,
      marketplace: located.marketplaceName,
    });
    const readme = await readReadmeIfPresent(previewResult.packagePath);
    return { manifest: previewResult.manifest, readme };
  } catch (err) {
    deps.logger.warn('[marketplace_get] preview() failed; returning marketplace.json entry only', {
      package: packageName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { manifest: null, readme: undefined };
  }
}

/**
 * Best-effort read of `README.md` from a staged package path. Returns
 * `undefined` (not an error) when the file does not exist or cannot be read,
 * matching the contract documented on {@link createGetHandler}.
 *
 * @internal
 */
async function readReadmeIfPresent(packagePath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(packagePath, 'README.md'), 'utf-8');
  } catch {
    return undefined;
  }
}
