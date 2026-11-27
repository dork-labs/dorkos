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
 * session gate: when login is enabled it requires a session cookie or a
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
 * — and the translation lives in `capability-dispatch.ts`, shared with each
 * capability's own REST path (`routes/capability-http.ts`): an agent calling a `destructive`
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
 * ## Extension tools
 *
 * A running extension's tools (DOR-2685) are reachable here by id too, although
 * they advertise only the in-session MCP surface. That is deliberate: every
 * call still goes through `registry.invoke`, so the same tier and permission
 * gate decides it exactly as it would in a session. An `ext_` id whose
 * extension is stopped answers `503` with the same "isn't available right now"
 * sentence the in-session tool gives, not an "unknown capability" 404.
 *
 * @module routes/capabilities-invoke
 */
import { Hono } from 'hono';

import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import type { ApiEnv } from '../http/api-chain.js';
import { dispatchCapability, type CapabilityDoorPorts } from './capability-dispatch.js';
import { readJsonBody } from '@dorkos/http-kit';

/**
 * Build the capability-invoke router over a composed registry.
 *
 * Dispatch runs entirely through the registry, so a capability is reachable
 * here the moment its domain composes, with no per-capability route wiring. The
 * request body is the capability's raw input (an empty POST defaults to `{}`);
 * the registry parses it against the capability's Zod input schema. What each
 * outcome answers is {@link dispatchCapability}'s table, shared with every
 * capability's own REST path.
 *
 * @param registry - The boot-composed capability registry to dispatch through.
 * @param ports - The bars and prechecks a declared capability runs first, the
 *   same ones its REST path runs (the account-decision bar, DOR-4978).
 * @returns The routes serving `POST /:id/invoke`, for `app.route('/api/capabilities', …)`.
 */
export function createCapabilitiesInvokeRoutes(
  registry: CapabilityRegistry,
  ports?: CapabilityDoorPorts
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  // A request with no body reads as none at all, as Express 5's `req.body`
  // did; capabilities with an empty input schema (`config.get`) accept `{}`.
  router.post('/:id/invoke', (c) =>
    dispatchCapability(c, {
      registry,
      id: c.req.param('id'),
      input: readJsonBody(c, { emptyAs: {} }),
      ...(ports ? { ports } : {}),
    })
  );
  return router;
}
