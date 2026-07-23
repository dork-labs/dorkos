/**
 * `POST /api/capabilities/:id/invoke` — the generic capability dispatch endpoint
 * (spec `capability-registry`, task 2.4).
 *
 * This is the HTTP form of {@link CapabilityRegistry.invoke}: it looks a
 * capability up by id, validates the JSON request body against that capability's
 * input schema, invokes its handler, and returns the plain result. It is the
 * capability-shaped path the CLI's `dorkos call` verb rides, and it lets any
 * HTTP client reach every capability — including those with no curated route of
 * their own — by id.
 *
 * ## Auth posture
 *
 * The endpoint is mounted under `/api/*`, so it inherits the app-wide
 * {@link sessionGate}: when login is enabled it requires a session cookie or a
 * per-user API key, exactly like every other `/api/*` route (config, agents,
 * tasks). It deliberately does NOT use the external `/mcp` server's tokenless
 * read-only carve-out — a mutating capability (`operator.update_agent`,
 * `operator.config_patch`, `marketplace.install`, …) is therefore never reachable
 * through a tokenless path here; its posture matches the curated mutation routes.
 *
 * @module routes/capabilities-invoke
 */
import { Router } from 'express';
import { z } from 'zod';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import { CapabilityToolError } from '../services/core/capabilities/index.js';
import { logger } from '../lib/logger.js';

/**
 * Build the capability-invoke router over a composed registry.
 *
 * Dispatch runs entirely through the registry (`get` + `invoke`), so a
 * capability is reachable here the moment its domain composes — no per-capability
 * route wiring. The request body is the capability's raw input (an empty POST
 * defaults to `{}`); the registry parses it against the capability's Zod input
 * schema before invoking.
 *
 * @param registry - The boot-composed capability registry to dispatch through.
 * @returns An Express router serving `POST /:id/invoke` (mounted at `/api/capabilities`).
 */
export function createCapabilitiesInvokeRouter(registry: CapabilityRegistry): Router {
  const router = Router();

  router.post('/:id/invoke', async (req, res) => {
    const { id } = req.params;

    if (!registry.get(id)) {
      return res
        .status(404)
        .json({ error: `Unknown capability: ${id}`, code: 'UNKNOWN_CAPABILITY' });
    }

    // Express 5 leaves `req.body` undefined on an empty POST; capabilities with
    // an empty input schema (`config.get`, `check_update`) accept `{}`.
    const input = req.body ?? {};

    try {
      const result = await registry.invoke(id, input);
      return res.json(result);
    } catch (err) {
      // Input failed the capability's Zod input contract — a client error.
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: z.flattenError(err) });
      }
      // The handler returned an `isError` result (e.g. agent not found, system
      // agent protected, invalid config patch). Surface its structured payload
      // verbatim so the caller sees the capability's own message.
      if (err instanceof CapabilityToolError) {
        const payload = err.payload;
        if (payload && typeof payload === 'object') {
          return res.status(400).json(payload);
        }
        return res.status(400).json({ error: String(payload) });
      }
      logger.error('[capabilities] invoke failed', { id, err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
