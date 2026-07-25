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
 * ## The HTTP half of the tier gate
 *
 * On top of transport auth, this is one of the three enforcement choke points
 * (spec `agent-trust` §3.2). Every dispatch runs
 * {@link enforceCapabilityTier} before `registry.invoke`, so an agent calling a
 * `destructive` capability gets `202` with an `approval_required` payload rather
 * than the operation, and an agent whose tier ceiling forbids the call gets `403`.
 * The retry carries its approval token in the `X-DorkOS-Approval` header, never in
 * the body: the body IS the capability's input, and the approval is bound to a
 * hash of that input.
 *
 * @module routes/capabilities-invoke
 */
import { Router } from 'express';
import { z } from 'zod';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import {
  APPROVAL_TOKEN_HEADER,
  CapabilityToolError,
  enforceCapabilityTier,
} from '../services/core/capabilities/index.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
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

    const capability = registry.get(id);
    if (!capability) {
      return res
        .status(404)
        .json({ error: `Unknown capability: ${id}`, code: 'UNKNOWN_CAPABILITY' });
    }

    // Express 5 leaves `req.body` undefined on an empty POST; capabilities with
    // an empty input schema (`config.get`, `check_update`) accept `{}`.
    const input = req.body ?? {};

    try {
      // Attribute the call when the caller presented a resolved agent token
      // (`X-DorkOS-Agent`). Absent one, this is `undefined` and the invocation
      // runs exactly as it did before identity existed.
      const identity = getRequestAgentIdentity(res);

      // Parse here rather than inside the registry so the approval binds to the
      // input that will really execute (defaults applied, unknown keys stripped),
      // not to whatever JSON arrived. `registry.invoke` parses it again, which is
      // only safe while every destructive schema is parse-idempotent — asserted
      // per destructive capability by the conformance suite, so a future
      // non-idempotent `.transform()` fails there rather than quietly making the
      // approval binding cover something other than what runs.
      const parsed = capability.input.parse(input);
      const header = req.headers[APPROVAL_TOKEN_HEADER];
      const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();

      const decision = enforceCapabilityTier({
        capability,
        input: parsed,
        ...(identity ? { identity } : {}),
        ...(approvalToken ? { approvalToken } : {}),
        retryChannel: 'http-header',
      });
      // 202: the request was recorded and is waiting on a person, so the caller
      // should come back. 403: refused, and no retry will change that.
      if (decision.outcome === 'approval_required') {
        return res.status(202).json(decision.payload);
      }
      if (decision.outcome === 'denied') {
        return res.status(403).json(decision.payload);
      }

      const result = await registry.invoke(id, parsed, {
        ...(identity ? { identity } : {}),
        ...(decision.approval ? { approval: decision.approval } : {}),
      });
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
