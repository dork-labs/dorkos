/**
 * The one listing fetch a newly added marketplace source gets (DOR-2304).
 *
 * Saving a source used to leave its `marketplace.json` uncached, so the first
 * install from it failed with "no cached document" until someone ran a
 * refresh by hand. Adding now fetches once, right after saving, through
 * {@link PackageFetcher.fetchMarketplaceJson} — the call
 * `POST /sources/:name/refresh` makes — so it inherits the same URL policy,
 * the same `MARKETPLACE_JSON_TIMEOUT_MS` deadline, the same in-place
 * read for a `file://` folder and the same cache write.
 *
 * Best effort by design: the source is already saved when this runs, and a
 * server that is down right now is no reason to lose it. A failure comes back
 * as a reason rather than an error, and a later refresh tries again.
 *
 * @module services/marketplace/source-listing
 */
import type { SourceListingOutcome } from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import type { PackageFetcher } from './package-fetcher.js';
import type { MarketplaceSource } from './types.js';

/**
 * Fetch and cache a just-added source's listing, never throwing.
 *
 * @param fetcher - The marketplace fetcher (only `fetchMarketplaceJson` is used).
 * @param source - The source exactly as it was saved.
 * @returns Whether the listing was fetched: its package count, or why not.
 */
export async function fetchNewSourceListing(
  fetcher: Pick<PackageFetcher, 'fetchMarketplaceJson'>,
  source: MarketplaceSource
): Promise<SourceListingOutcome> {
  try {
    const marketplace = await fetcher.fetchMarketplaceJson(source);
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
