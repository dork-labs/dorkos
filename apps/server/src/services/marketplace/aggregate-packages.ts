/**
 * Every package every enabled marketplace lists, flattened into one list for
 * `GET /api/marketplace/packages`.
 *
 * @module services/marketplace/aggregate-packages
 */
import {
  mergeMarketplace,
  primaryCategory,
  type MergedMarketplaceEntry,
  type PluginSource,
} from '@dorkos/marketplace';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import type { PackageFetcher } from './package-fetcher.js';
import type { MarketplaceSource } from './types.js';

/**
 * Aggregate package entries from every enabled marketplace source into a
 * single flat list, tagging each entry with its origin marketplace name.
 * A single marketplace fetch failure is logged and skipped so one broken
 * source never blocks the whole listing.
 *
 * On completion, logs an info summary of `source → plugin count` for
 * every source — including zero-count sources — so the "empty results"
 * case is self-explanatory in logs without having to grep for warnings.
 *
 * @param sources - The sources to list from.
 * @param fetcher - Fetches each source's listing.
 */
export async function aggregatePackages(
  sources: MarketplaceSource[],
  fetcher: PackageFetcher
): Promise<AggregatedPackage[]> {
  const results: AggregatedPackage[] = [];
  const breakdown: Record<string, number | string> = {};
  for (const source of sources) {
    try {
      const [json, sidecar] = await Promise.all([
        fetcher.fetchMarketplaceJson(source),
        fetcher.fetchDorkosSidecar(source),
      ]);
      const { entries, orphans } = mergeMarketplace(json, sidecar);
      if (orphans.length > 0) {
        logger.warn('[Marketplace] Orphan sidecar entries', {
          marketplace: source.name,
          orphans,
        });
      }
      for (const entry of entries) {
        results.push(flattenMergedEntry(entry, source.name, source.source));
      }
      breakdown[source.name] = entries.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      breakdown[source.name] = `error: ${message}`;
      logger.warn(`[Marketplace] Failed to fetch marketplace for ${source.name}: ${message}`);
    }
  }
  logger.info('[Marketplace] Aggregated packages from enabled sources', {
    totalPlugins: results.length,
    sourceCount: sources.length,
    perSource: breakdown,
  });
  return results;
}

/**
 * Convert a {@link PluginSource} discriminated union into a giget-compatible
 * template reference string.
 *
 * Handles all five source forms:
 * - **Relative path** (string starting with `./`) — resolved against the
 *   marketplace source URL. E.g. marketplace `https://github.com/dork-labs/marketplace`
 *   + source `./plugins/security-auditor` → `github:dork-labs/marketplace/plugins/security-auditor`.
 * - **GitHub** — `github:owner/repo`
 * - **URL** — the clone URL as-is
 * - **Git subdir** — the clone URL as-is (subpath handled at install time)
 * - **npm** — not supported for template download; passes `npm:<package>` so
 *   downstream callers produce a clear error rather than a cryptic git failure.
 *
 * @internal Exported for testing only.
 */
export function resolvePackageSource(entrySource: PluginSource, marketplaceUrl: string): string {
  // String source = relative path (e.g. `./plugins/foo`) or bare name
  if (typeof entrySource === 'string') {
    if (!entrySource.startsWith('./') && !entrySource.startsWith('../')) return entrySource;

    const ghMatch = marketplaceUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (!ghMatch) return entrySource; // Can't resolve — pass through as-is

    const orgRepo = ghMatch[1];
    const subpath = entrySource.replace(/^\.\//, '');
    return `github:${orgRepo}/${subpath}`;
  }

  // Object source — dispatch on discriminator
  switch (entrySource.source) {
    case 'github':
      return `github:${entrySource.repo}`;
    case 'url':
      return entrySource.url;
    case 'git-subdir':
      return entrySource.url;
    case 'npm':
      return `npm:${entrySource.package}`;
  }
}

/**
 * Flatten a {@link MergedMarketplaceEntry} (CC fields + nested DorkOS sidecar)
 * into the flat {@link AggregatedPackage} shape expected by the client.
 */
function flattenMergedEntry(
  entry: MergedMarketplaceEntry,
  marketplace: string,
  marketplaceUrl: string
): AggregatedPackage {
  return {
    name: entry.name,
    displayName: entry.dorkos?.displayName,
    source: resolvePackageSource(entry.source, marketplaceUrl),
    description: entry.description,
    version: entry.version,
    author: typeof entry.author === 'object' ? entry.author?.name : undefined,
    homepage: entry.homepage,
    repository: entry.repository,
    license: entry.license,
    keywords: entry.keywords,
    categories: entry.dorkos?.categories,
    // Primary category prefers the sidecar's categories[0], falling back to the
    // CC-inline singular category so single-category consumers keep working.
    category: primaryCategory(entry.dorkos?.categories, entry.category),
    tags: entry.tags,
    type: entry.dorkos?.type,
    // Gated on type so the AggregatedPackage contract ("present only for
    // adapter packages") is enforced here, not merely documented — a sidecar
    // that sets adapterType on a non-adapter entry does not leak it downstream.
    adapterType: entry.dorkos?.type === 'adapter' ? entry.dorkos.adapterType : undefined,
    icon: entry.dorkos?.icon,
    featured: entry.dorkos?.featured,
    marketplace,
  };
}
