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
 * On top of transport auth, every dispatch is gated (spec `agent-trust` §3.2).
 * This route does not gate it — `registry.invoke` does, from the inside (DOR-467)
 * — so all this module owns is the translation: an agent calling a `destructive`
 * capability gets `202` with an `approval_required` payload rather than the
 * operation, and one whose tier ceiling forbids the call gets `403`.
 *
 * The retry carries its approval token in the `X-DorkOS-Approval` header, never in
 * the body: the body IS the capability's input, and the approval is bound to a
 * hash of that input.
 *
 * This route never mints a trusted caller, even for a signed-in operator. It is
 * the generic agent actuation path, and the cost of gating it is one Allow click
 * for a person running a destructive capability from a shell.
 *
 * @module routes/capabilities-invoke
 */
import { Router } from 'express';
import { z } from 'zod';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import {
  APPROVAL_TOKEN_HEADER,
  CapabilityGateRefusal,
  CapabilityToolError,
} from '../services/core/capabilities/index.js';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestUser } from '../services/core/auth/index.js';
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
      // runs unattributed — which does NOT make it ungated: the capability's tier
      // decides that, so dropping a credential can never widen what a caller
      // reaches (see `tier-enforcement.ts`).
      const identity = getRequestAgentIdentity(res);
      // The WIDER fact, stated separately: a token that did not resolve still
      // means a machine is calling. Without it, a handler that turns the caller
      // into a domain principal cannot tell a revoked agent from the person at
      // the keyboard — which is how `rooms.post` came to write as the operator
      // (DOR-1361, `room-capabilities.ts`'s `callerAuthor`). It changes no tier
      // decision; the tier still decides that on its own.
      const agentIdentityPresented = presentsAgentIdentity(req, res);
      const header = req.headers[APPROVAL_TOKEN_HEADER];
      const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();

      // This route deliberately never mints a trusted marker, even for a
      // signed-in operator: it is the generic agent actuation path (`dorkos
      // call`), and the product cost of gating it is one Allow click for a person
      // running a destructive capability from a shell, which is what spec
      // `agent-trust` §UX describes anyway.
      // The signed-in person, when login is on and `sessionGate` verified one.
      // A capability that acts on somebody's own data needs to know WHICH
      // person, and "no agent token" is not the same fact as "the owner" —
      // reading it that way is how an invited user's key reached the owner's
      // rooms (see `CapabilityInvocationContext.userId`).
      const user = res.locals.user as RequestUser | undefined;
      const result = await registry.invoke(id, input, {
        ...(identity ? { identity } : {}),
        ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
        ...(user ? { userId: user.userId } : {}),
        ...(approvalToken ? { approvalToken } : {}),
        retryChannel: 'http-header',
      });
      return res.json(result);
    } catch (err) {
      // 202: the request was recorded and is waiting on a person, so the caller
      // should come back. 403: refused, and no retry will change that.
      if (err instanceof CapabilityGateRefusal) {
        const status = err.decision.outcome === 'approval_required' ? 202 : 403;
        return res.status(status).json(err.decision.payload);
      }
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
