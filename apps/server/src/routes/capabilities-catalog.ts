/**
 * `GET /api/capabilities/catalog` — the live capability self-description catalog
 * (spec `capability-registry`, task 2.3), filtered and paginated (DOR-940).
 *
 * Returns a bounded page of the composed registry, identical to what the
 * `list_capabilities` MCP tool serves: the two surfaces run the SAME
 * {@link projectCatalog} over `registry.catalog()`, so there is no second filter
 * to keep in sync. A no-query request returns the compact, bounded default; the
 * `domain`, `query`, `detail`, `limit`, and `cursor` query parameters narrow it.
 *
 * The bare `/api/capabilities` path already serves the per-runtime capability
 * matrix (a different, client-facing contract), so the registry catalog lives one
 * segment deeper at `/api/capabilities/catalog`. The route is declared as the
 * `capabilities.list` capability's `http` surface, so its query parameters and
 * response schema project into OpenAPI from that one capability (task 2.5).
 *
 * @module routes/capabilities-catalog
 */
import { Hono } from 'hono';

import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { validationFailureBody } from '../lib/route-utils.js';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import {
  InvalidCursorError,
  listCapabilitiesInputSchema,
  projectCatalog,
} from '../services/core/self-description/catalog-projection.js';

/**
 * The capability-catalog routes over a composed registry.
 *
 * @param registry - The boot-composed capability registry to serialize.
 * @returns The routes serving `GET /`, for `app.route('/api/capabilities/catalog', …)`.
 */
export function createCapabilitiesCatalogRoutes(registry: CapabilityRegistry): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.get('/', (c) => {
    const parsed = listCapabilitiesInputSchema.safeParse(readQuery(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    try {
      return c.json(projectCatalog(registry.catalog(), parsed.data));
    } catch (err) {
      if (err instanceof InvalidCursorError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  return router;
}
