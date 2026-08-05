/**
 * The credential gate for durable-stream WebSocket upgrades.
 *
 * **This is the file that replaces `sessionGate` for sockets.** An upgrade never
 * touches Express, so the app-wide middleware chain — `sessionGate` and
 * `resolveAgentIdentity` — does not run for it. Without this, moving the durable
 * streams from SSE to WebSockets would have silently un-gated every one of them
 * on an install with login enabled: the same URL, the same data, no credential.
 *
 * It reproduces that chain's two outcomes exactly, and nothing else:
 *
 * 1. **The gate.** When `config.auth.enabled` is `true`, a caller must present a
 *    valid session cookie or a per-user API key, verified through the same
 *    {@link verifyRequestAuth} the HTTP gate and the MCP middleware use. When
 *    login is off it is a pass-through, as the gate is. None of `sessionGate`'s
 *    exemptions apply here: they cover sign-in, the health probe and the
 *    signed-token workbench routes, none of which is a durable stream.
 * 2. **The attribution.** `X-DorkOS-Agent` is resolved the same additive way the
 *    middleware resolves it — never a rejection, only an identity when the token
 *    is good — because a room stream is membership-scoped and an agent reading
 *    one must resolve to itself rather than to the operator.
 *
 * The result is shaped as `res.locals` on purpose: `resolveCaller` and
 * `getRequestAgentIdentity` read identity from there, and handing them the same
 * shape is what lets the socket handlers reuse them unchanged instead of
 * growing a parallel notion of who a caller is.
 *
 * ## What a browser sends on an upgrade
 *
 * A `WebSocket` handshake carries the target origin's cookies automatically —
 * there is no `credentials: 'include'` to set and no way to add headers. So the
 * cookie branch works for the cockpit exactly as it did over SSE. The Bearer
 * branch is reachable only by non-browser callers, which is also true of the
 * HTTP gate.
 *
 * @module services/core/streams/stream-upgrade-auth
 */
import type { IncomingHttpHeaders } from 'node:http';
import { configManager } from '../config-manager.js';
import { verifyRequestAuth } from '../auth/session-gate.js';
import { resolveAgentIdentityFromHeaders } from '../../../middleware/agent-identity.js';
import type { UpgradeDecision } from './upgrade-router.js';

/**
 * The request-scoped identity slots the Express chain fills, as a socket
 * handler can supply them to `resolveCaller` / `getRequestAgentIdentity`.
 */
export interface StreamUpgradeLocals {
  /** Present only when login is enabled and a credential verified. */
  user?: Awaited<ReturnType<typeof verifyRequestAuth>>;
  /** Present only when a valid `X-DorkOS-Agent` token was offered. */
  agentIdentity?: Awaited<ReturnType<typeof resolveAgentIdentityFromHeaders>>;
}

/** An authorized upgrade, carrying the identity the handler should act as. */
export interface AuthorizedStreamUpgrade {
  readonly ok: true;
  /** The `res.locals`-shaped identity, for `resolveCaller`. */
  readonly locals: StreamUpgradeLocals;
}

/**
 * Run the durable-stream credential gate over an upgrade's headers.
 *
 * @param headers - The upgrade request's headers.
 * @returns The resolved identity, or a `401` refusal for the router to write.
 */
export async function authorizeStreamUpgrade(
  headers: IncomingHttpHeaders
): Promise<AuthorizedStreamUpgrade | Extract<UpgradeDecision, { ok: false }>> {
  const locals: StreamUpgradeLocals = {};

  if (configManager.get('auth')?.enabled) {
    const user = await verifyRequestAuth({ headers });
    if (!user) return { ok: false, status: 401, message: 'Unauthorized' };
    locals.user = user;
  }

  const agentIdentity = await resolveAgentIdentityFromHeaders(headers);
  if (agentIdentity) locals.agentIdentity = agentIdentity;

  return { ok: true, locals };
}
