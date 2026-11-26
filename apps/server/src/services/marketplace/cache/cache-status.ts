/**
 * The package cache's counts and size, as `GET /api/marketplace/cache` reports them.
 *
 * @module services/marketplace/cache/cache-status
 */
import { join } from 'node:path';
import type { MarketplaceCache } from './marketplace-cache.js';
import { directorySize } from '../lib/directory-size.js';
import { safeReaddir } from '../lib/safe-readdir.js';

/**
 * Compute counts + total size of the marketplace cache.
 *
 * @param cache - The marketplace cache.
 */
export async function computeCacheStatus(cache: MarketplaceCache): Promise<{
  marketplaces: number;
  packages: number;
  totalSizeBytes: number;
}> {
  const marketplacesRoot = join(cache.cacheRoot, 'marketplaces');
  const marketplaceDirs = await safeReaddir(marketplacesRoot);
  const packages = await cache.listPackages();

  const [marketplacesBytes, packagesBytes] = await Promise.all([
    directorySize(marketplacesRoot),
    sumPackageSizes(packages),
  ]);

  return {
    marketplaces: marketplaceDirs.length,
    packages: packages.length,
    totalSizeBytes: marketplacesBytes + packagesBytes,
  };
}

/** Sum the recursive size of every cached package directory. */
async function sumPackageSizes(packages: { path: string }[]): Promise<number> {
  let total = 0;
  for (const pkg of packages) {
    total += await directorySize(pkg.path);
  }
  return total;
}
