/**
 * The one listing fetch a newly added marketplace source gets (DOR-2304).
 *
 * Saving a source used to leave its `marketplace.json` uncached, so the first
 * install from it failed with "no cached document" until someone ran a
 * refresh by hand. Adding now fetches once, right after saving, through
 * {@link PackageFetcher.fetchMarketplaceJson} — the call
 * `POST /sources/:name/refresh` makes — so it inherits the same URL policy,
 * the same `MARKETPLACE_JSON_TIMEOUT_MS` deadline, the same in-place read for
 * a `file://` folder, the same plain-words failure reasons and the same cache
 * write.
 *
 * Two things differ from refresh, both so that `fetched: true` only ever means
 * "fetched just now, from this source":
 *
 * - Whatever is cached under the name is forgotten first. Listings are cached
 *   by source NAME, and a source removed before removal cleared its listing
 *   left one on disk for the next source given that name to inherit.
 * - The fetch never falls back to a cached copy.
 *
 * Best effort by design: the source is already saved when this runs, and a
 * server that is down right now is no reason to lose it. A failure comes back
 * as a reason rather than an error, and a later refresh tries again. A source
 * added turned off is not fetched at all.
 *
 * @module services/marketplace/source-listing
 */
import type { SourceListingOutcome } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import type { MarketplaceCache } from './marketplace-cache.js';
import type { PackageFetcher } from './package-fetcher.js';
import type { MarketplaceSource } from './types.js';

/** What {@link fetchNewSourceListing} needs. */
export interface NewSourceListingDeps {
  /** The marketplace fetcher (only `fetchMarketplaceJson` is used). */
  fetcher: Pick<PackageFetcher, 'fetchMarketplaceJson'>;
  /** The cache, to forget a listing an earlier source of the same name left. */
  cache: Pick<MarketplaceCache, 'removeMarketplace'>;
}

/** The reason given for a source added turned off. */
export const DISABLED_SOURCE_LISTING_REASON =
  "it was added turned off, so DorkOS didn't fetch its listing";

/**
 * Fetch and cache a just-added source's listing, never throwing.
 *
 * @param deps - The fetcher and the cache.
 * @param source - The source exactly as it was saved.
 * @returns Whether the listing was fetched: its package count, or why not.
 */
export async function fetchNewSourceListing(
  deps: NewSourceListingDeps,
  source: MarketplaceSource
): Promise<SourceListingOutcome> {
  if (!source.enabled) {
    return { fetched: false, reason: DISABLED_SOURCE_LISTING_REASON };
  }
  try {
    await deps.cache.removeMarketplace(source.name);
    const marketplace = await deps.fetcher.fetchMarketplaceJson(source, { staleFallback: false });
    return { fetched: true, packageCount: marketplace.plugins.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('[Marketplace] Added a source but could not fetch its listing yet', {
      name: source.name,
      reason,
    });
    return { fetched: false, reason };
  }
}
