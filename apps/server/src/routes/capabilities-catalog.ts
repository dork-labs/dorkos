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
import { Router } from 'express';
import { z } from 'zod';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import {
  InvalidCursorError,
  listCapabilitiesInputSchema,
  projectCatalog,
} from '../services/core/self-description/catalog-projection.js';

/**
 * Build the capability-catalog router over a composed registry.
 *
 * @param registry - The boot-composed capability registry to serialize.
 * @returns An Express router serving `GET /` (mounted at `/api/capabilities/catalog`).
 */
export function createCapabilitiesCatalogRouter(registry: CapabilityRegistry): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const parsed = listCapabilitiesInputSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
      return;
    }
    try {
      res.json(projectCatalog(registry.catalog(), parsed.data));
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
  return router;
}
