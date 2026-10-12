/**
 * Marketplace routes: `/cache`: the marketplace cache's status, clearing it, and pruning packages no install needs.
 *
 * @module routes/marketplace/cache
 */
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import type { MarketplaceCache } from '../../services/marketplace/cache/marketplace-cache.js';
import { UnreadableInstallsError } from '../../services/marketplace/cache/package-cache-retention.js';
import { directorySize } from '../../services/marketplace/lib/directory-size.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { readJsonBody } from '../../http/request-body.js';
import { safeReaddir, validationFailed } from './shared.js';

/**
 * Body schema for `POST /api/marketplace/cache/prune`: no options. Strict, so
 * the retired `keepLastN` is refused rather than silently ignored.
 */
const PruneCacheBodySchema = z.object({}).strict();

/** Compute counts + total size of the marketplace cache. */
async function computeCacheStatus(cache: MarketplaceCache): Promise<{
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

/**
 * Register the `/cache` routes on the marketplace router.
 *
 * @param app - The marketplace routes.
 * @param deps - The router's injected dependencies.
 * @param _ctx - The helpers every route group shares.
 */
export function mountCacheRoutes(
  app: MarketplaceRoutes,
  deps: MarketplaceRouteDeps,
  _ctx: MarketplaceRouteContext
): void {
  const { cache, cacheRetention } = deps;

  // GET /cache -- cache status (marketplace count, package count, total bytes,
  // and whether automatic cleanup is paused)
  app.get('/cache', async (c) => {
    try {
      const status = await computeCacheStatus(cache);
      return c.json({ ...status, cleanup: cacheRetention.status() });
    } catch (err) {
      logger.error('[Marketplace] Failed to read cache status', err);
      return c.json({ error: 'Failed to read cache status' }, 500);
    }
  });

  // DELETE /cache -- wipe the marketplace cache
  app.delete('/cache', async (c) => {
    try {
      await cache.clear();
      return c.body(null, 204);
    } catch (err) {
      logger.error('[Marketplace] Failed to clear cache', err);
      return c.json({ error: 'Failed to clear marketplace cache' }, 500);
    }
  });

  // POST /cache/prune -- remove cached packages no install needs (the same
  // sweep that runs after every fetch; see package-cache-retention.ts)
  app.post('/cache/prune', async (c) => {
    const parsed = PruneCacheBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) return validationFailed(c, parsed.error);

    try {
      const { removed, freedBytes } = await cacheRetention.sweep();
      return c.json({
        removed: removed.map((pkg) => ({
          packageName: pkg.packageName,
          commitSha: pkg.commitSha,
          path: pkg.path,
          lastUsedAt: pkg.lastUsedAt.toISOString(),
        })),
        freedBytes,
      });
    } catch (err) {
      if (err instanceof UnreadableInstallsError) {
        // Names the folder only in the log: it spells the operator's home.
        logger.warn('[Marketplace] cache prune stopped: could not read every install', {
          error: err.message,
        });
        return c.json(
          {
            error:
              "Couldn't check every installed package, so nothing was removed. The server log names the folder it couldn't read.",
          },
          503
        );
      }
      logger.error('[Marketplace] Failed to prune cache', err);
      return c.json({ error: 'Failed to prune marketplace cache' }, 500);
    }
  });
}
