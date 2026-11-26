/**
 * Marketplace routes: `/cache`: clearing the marketplace cache, and pruning packages no install needs. Its status is a capability (`services/marketplace/doors/`).
 *
 * @module routes/marketplace/cache
 */
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { UnreadableInstallsError } from '../../services/marketplace/cache/package-cache-retention.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import { validationFailed } from './shared.js';

/**
 * Body schema for `POST /api/marketplace/cache/prune`: no options. Strict, so
 * the retired `keepLastN` is refused rather than silently ignored.
 */
const PruneCacheBodySchema = z.object({}).strict();

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

  // DELETE /cache -- wipe the marketplace cache
  app.delete('/cache', async (c) => {
    try {
      await cache.clear();
      return c.body(null, 204);
    } catch (err) {
      logger.error('[Marketplace] Failed to clear cache', err);
      return problem(c, 'internal_error', {
        detail: "Couldn't clear the package cache. Try again.",
      });
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
        return problem(c, 'temporarily_unavailable', {
          detail: "Nothing was removed. Some installs couldn't be read; the server log names them.",
        });
      }
      logger.error('[Marketplace] Failed to prune cache', err);
      return problem(c, 'internal_error', {
        detail: "Couldn't clean up the package cache. Try again.",
      });
    }
  });
}
