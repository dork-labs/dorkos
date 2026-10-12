/**
 * Marketplace routes: `/sources`: list, add, remove and refresh marketplace sources (adding and removing are operator-only).
 *
 * @module routes/marketplace/sources
 */
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { InvalidSourceNameError } from '../../services/marketplace/sources/marketplace-source-manager.js';
import { UnsupportedSourceUrlError } from '../../services/marketplace/sources/source-url-policy.js';
import {
  describeLastFetch,
  fetchNewSourceListing,
  refreshSourceListing,
} from '../../services/marketplace/sources/source-listing.js';
import type { MarketplaceSource } from '../../services/marketplace/types.js';
import { readJsonBody } from '../../http/request-body.js';
import type { MarketplaceRouteDeps, MarketplaceRoutes } from '../marketplace.js';
import type { MarketplaceRouteContext } from './context.js';
import { validationFailed } from './shared.js';

/** Body schema for `POST /api/marketplace/sources`. */
export const AddSourceBodySchema = z.object({
  name: z.string().min(1).max(128),
  source: z.string().min(1),
  enabled: z.boolean().optional(),
});

/**
 * Register the `/sources` routes on the marketplace router.
 *
 * @param app - The marketplace routes.
 * @param deps - The router's injected dependencies.
 * @param ctx - The helpers every route group shares.
 */
export function mountSourceRoutes(
  app: MarketplaceRoutes,
  deps: MarketplaceRouteDeps,
  ctx: MarketplaceRouteContext
): void {
  const { sourceManager, cache, fetcher, updateFlow } = deps;
  const { refuseUntrustedSourceWrite } = ctx;

  // GET /sources -- list configured marketplace sources
  app.get('/sources', async (c) => {
    try {
      const sources = await sourceManager.list();
      // How each source's last fetch went, from the record the fetcher keeps
      // (DOR-2324), so a failed listing is still shown after a reload.
      const listed = await Promise.all(
        sources.map(async (source) => ({
          ...source,
          lastFetch: await describeLastFetch(cache, source.name),
        }))
      );
      return c.json({ sources: listed });
    } catch (err) {
      logger.error('[Marketplace] Failed to list sources', err);
      return c.json({ error: 'Failed to list marketplace sources' }, 500);
    }
  });

  // POST /sources -- add a new marketplace source (operator-only, DOR-502)
  app.post('/sources', async (c) => {
    // Ahead of validation on purpose: a caller that may not do this at all gets
    // one answer whatever it sent, rather than a schema it can probe.
    //
    // This deliberately does NOT match the three sibling mutation routes below.
    // `install`, `uninstall` and `update` all `safeParse` first and answer a bad
    // body with a 400 carrying `z.flattenError` details, before their gate ever
    // runs. That order is the older one and it is not changed here, because
    // reordering three gated routes is a separate change with its own blast
    // radius. Recording it so the difference reads as a decision rather than as
    // drift somebody has to rediscover: `uninstall` is the one worth revisiting,
    // since it is `destructive` and hands its schema to a caller it is then going
    // to stop with an approval card.
    const refused = refuseUntrustedSourceWrite(c, 'add');
    if (refused) return refused;

    const parsed = AddSourceBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) return validationFailed(c, parsed.error);

    let created: MarketplaceSource;
    try {
      created = await sourceManager.add(parsed.data);
    } catch (err) {
      // An address DorkOS will not fetch from. Answered here rather than left
      // to the 500 below: this is the caller's input, and the message names the
      // forms that do work. The address itself is logged rather than echoed —
      // the operator knows what they typed, and the log is where a support
      // question gets answered.
      if (err instanceof InvalidSourceNameError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof UnsupportedSourceUrlError) {
        logger.warn('[Marketplace] Refused an unsupported source address', {
          name: parsed.data.name,
          url: err.url,
        });
        return c.json({ error: err.message }, 400);
      }
      const message = err instanceof Error ? err.message : 'Failed to add marketplace source';
      if (message.includes('already exists')) {
        return c.json({ error: message }, 409);
      }
      logger.error('[Marketplace] Failed to add source', err);
      return c.json({ error: 'Failed to add marketplace source' }, 500);
    }

    // One best-effort fetch of the new listing, the way refresh fetches it, so
    // the first install does not need a refresh first (DOR-2304). It never
    // throws: a failure is reported in `listing`, and the source stays saved.
    const listing = await fetchNewSourceListing({ fetcher, cache }, created);
    return c.json({ ...created, listing }, 201);
  });

  // DELETE /sources/:name -- remove a marketplace source (operator-only, DOR-502)
  app.delete('/sources/:name', async (c) => {
    const refused = refuseUntrustedSourceWrite(c, 'remove');
    if (refused) return refused;
    const name = c.req.param('name');

    try {
      await sourceManager.remove(name);
    } catch (err) {
      logger.error(`[Marketplace] Failed to remove source ${name}`, err);
      return c.json({ error: 'Failed to remove marketplace source' }, 500);
    }
    // Its listing goes with it: listings are cached by name, and one left
    // behind would pass for the listing of the next source given that name
    // (DOR-2304). The source is already gone, so a failure here is logged
    // rather than answered — adding a source clears the name again anyway.
    updateFlow.clearMemos();
    try {
      await cache.removeMarketplace(name);
    } catch (err) {
      logger.warn(`[Marketplace] Removed source ${name} but kept its listing`, err);
    }
    return c.body(null, 204);
  });

  // POST /sources/:name/refresh -- force refetch of a source's marketplace.json
  app.post('/sources/:name/refresh', async (c) => {
    const name = c.req.param('name');
    try {
      const source = await sourceManager.get(name);
      if (!source) {
        return c.json({ error: `Marketplace source '${name}' not found` }, 404);
      }

      // "Check now": an unreachable source answers with its last copy marked
      // `stale`, never the old copy passed off as new (DOR-2304).
      const refreshed = await refreshSourceListing({ fetcher, cache }, source);
      // "I just pushed; check again": the update check shares commit lookups
      // for a minute, and a refresh is how the operator asks it to look now.
      updateFlow.clearMemos();
      return c.json(refreshed);
    } catch (err) {
      logger.error(`[Marketplace] Failed to refresh source ${name}`, err);
      const message = err instanceof Error ? err.message : 'Failed to refresh marketplace source';
      return c.json({ error: message }, 502);
    }
  });
}
