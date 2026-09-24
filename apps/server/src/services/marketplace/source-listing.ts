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
import type {
  RefreshedMarketplaceSource,
  SourceLastFetch,
  SourceListingOutcome,
} from '@dorkos/shared/marketplace-schemas';
import { logger } from '../../lib/logger.js';
import type { MarketplaceCache } from './marketplace-cache.js';
import type { PackageFetcher } from './package-fetcher.js';
import type { MarketplaceSource } from './types.js';

/** What {@link fetchNewSourceListing} needs. */
export interface NewSourceListingDeps {
  /** The marketplace fetcher (only `fetchMarketplaceJson` is used). */
  fetcher: Pick<PackageFetcher, 'fetchMarketplaceJson'>;
  /** The cache, to forget a listing an earlier source of the same name left. */
  cache: Pick<MarketplaceCache, 'removeMarketplace' | 'readMarketplace'>;
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
  try {
    // First, whatever the outcome: an old listing under this name must not
    // outlive the add, fetched or not.
    await deps.cache.removeMarketplace(source.name);
    if (!source.enabled) {
      return { fetched: false, reason: DISABLED_SOURCE_LISTING_REASON };
    }
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

/**
 * Fetch a source's listing now, for `POST /sources/:name/refresh`.
 *
 * A refresh is "check now", so it never quietly answers with the cached copy:
 * it fetches with no stale fallback. When that fails and a copy is cached, it
 * answers with that copy, marked `stale: true`, with the reason and the time
 * the copy was fetched, so the caller can say "couldn't reach it, still
 * showing the copy from <time>" instead of reporting success. With nothing
 * cached, the fetch error is rethrown.
 *
 * @param deps - The fetcher and the cache.
 * @param source - The configured source to refresh.
 * @returns The listing, when it was fetched, and whether it is an old copy.
 * @throws The fetch error when the fetch fails and nothing is cached.
 */
export async function refreshSourceListing(
  deps: NewSourceListingDeps,
  source: MarketplaceSource
): Promise<RefreshedMarketplaceSource> {
  try {
    const marketplace = await deps.fetcher.fetchMarketplaceJson(source, { staleFallback: false });
    return { marketplace, fetchedAt: new Date().toISOString(), stale: false };
  } catch (err) {
    const cached = await deps.cache.readMarketplace(source.name);
    if (!cached) throw err;
    return {
      marketplace: cached.json,
      fetchedAt: cached.fetchedAt.toISOString(),
      stale: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Describe how the most recent fetch of a source's listing went (DOR-2324),
 * from the record the fetcher keeps beside the listing and the time the
 * cached copy was fetched. The record carries the package count, so the
 * listing itself is read only for a copy that has no count on record.
 *
 * - A failure is reported as `fetched` when the copy on disk was written
 *   after that failed attempt started (strictly: the same millisecond proves
 *   nothing): a success that began earlier but finished later is what is
 *   listed now.
 * - A copy with no record (cached before DOR-2324) reads as `fetched` at the
 *   copy's own date, not as `never`.
 *
 * @param cache - The cache's read doors.
 * @param sourceName - The source's name.
 * @returns The source's last-fetch state.
 */
export async function describeLastFetch(
  cache: Pick<MarketplaceCache, 'readFetchStatus' | 'readMarketplaceFetchedAt' | 'readMarketplace'>,
  sourceName: string
): Promise<SourceLastFetch> {
  const [status, copyAt] = await Promise.all([
    cache.readFetchStatus(sourceName),
    cache.readMarketplaceFetchedAt(sourceName),
  ]);
  if (!copyAt) {
    return status && !status.ok
      ? {
          state: 'failed',
          checkedAt: status.checkedAt,
          reason: status.reason ?? 'no reason was recorded',
        }
      : { state: 'never' };
  }
  // Strictly later: a copy stamped in the same millisecond the failed attempt
  // started cannot be shown to be newer, so the failure is what is reported.
  const copyIsNewer =
    status !== null && !status.ok && copyAt.getTime() > Date.parse(status.startedAt);
  if (!status || status.ok || copyIsNewer) {
    return {
      state: 'fetched',
      checkedAt: status?.ok ? status.checkedAt : copyAt.toISOString(),
      // Only a success's count is the count of this copy.
      packageCount:
        status?.ok && status.packageCount !== undefined
          ? status.packageCount
          : await countFromCopy(cache, sourceName),
    };
  }
  return {
    state: 'stale',
    checkedAt: status.checkedAt,
    reason: status.reason ?? 'no reason was recorded',
    copyFetchedAt: copyAt.toISOString(),
    packageCount: status.packageCount ?? (await countFromCopy(cache, sourceName)),
  };
}

/** Count the packages in the cached copy itself, for a copy with no count on record. */
async function countFromCopy(
  cache: Pick<MarketplaceCache, 'readMarketplace'>,
  sourceName: string
): Promise<number> {
  return (await cache.readMarketplace(sourceName))?.json.plugins.length ?? 0;
}
