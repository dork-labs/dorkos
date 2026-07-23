/**
 * `GET /api/capabilities/catalog` — the live capability self-description catalog
 * (spec `capability-registry`, task 2.3).
 *
 * Returns the composed registry's {@link CapabilityRegistry.catalog} verbatim:
 * `{ catalogVersion, generatedAt, capabilities: [...] }`. This is the same
 * payload the `list_capabilities` MCP tool and the `dorkos://capabilities`
 * resource serve; the CLI's `dorkos capabilities` verb reads it too.
 *
 * The bare `/api/capabilities` path already serves the per-runtime capability
 * matrix (a different, client-facing contract), so the registry catalog lives one
 * segment deeper at `/api/capabilities/catalog`. The route is declared as the
 * `capabilities.list` capability's `http` surface, so it projects into OpenAPI
 * (task 2.5).
 *
 * @module routes/capabilities-catalog
 */
import { Router } from 'express';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';

/**
 * Build the capability-catalog router over a composed registry.
 *
 * @param registry - The boot-composed capability registry to serialize.
 * @returns An Express router serving `GET /` (mounted at `/api/capabilities/catalog`).
 */
export function createCapabilitiesCatalogRouter(registry: CapabilityRegistry): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(registry.catalog());
  });
  return router;
}
