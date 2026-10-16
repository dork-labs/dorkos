/**
 * The credential gate for durable-stream WebSocket upgrades.
 *
 * **This is the file that replaces the session gate for sockets.** An upgrade
 * never runs the chain, so the session gate and
 * `resolveAgentIdentityFromHeaders` do not run for it. Without this, moving the durable
 * streams from SSE to WebSockets would have silently un-gated every one of them
 * on an install with login enabled: the same URL, the same data, no credential.
 *
 * It reproduces that chain's two outcomes exactly, and nothing else:
 *
 * 1. **The gate.** The same per-request answer the HTTP gate reads
 *    (`gateAccessFor`): when the request needs a credential, a caller must
 *    present a valid session cookie or a per-user API key, verified through the
 *    same {@link verifyRequestAuth} the HTTP gate and the MCP middleware use; a
 *    person at this computer that does not ask passes, as at the gate; a
 *    relayed caller is refused. None of the session
 *    gate's exemptions apply here: they cover sign-in, the health probe and the
 *    signed-token workbench routes, none of which is a durable stream.
 * 2. **The attribution.** `X-DorkOS-Agent` is resolved the same additive way the
 *    middleware resolves it — never a rejection, only an identity when the token
 *    is good — because a room stream is membership-scoped and an agent reading
 *    one must resolve to itself rather than to the operator.
 *
 * The result carries the same two identity fields a request's facts do
 * (`http/request-facts.ts`), so a socket handler passes
 * {@link upgradeCaller}`(headers, locals)` to `resolveCaller`,
 * `readCallerPrincipal` and the other caller policies unchanged instead of
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
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { gateAccessFor } from '../auth/gate-policy.js';
import { ingressOf } from '../remote/ingress-mark.js';
import { verifyRequestAuth, type RequestUser } from '../auth/session-gate.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type { RequestFacts } from '../../../http/request-facts.js';
import { resolveAgentIdentityFromHeaders } from '../../../middleware/agent-identity.js';
import type { UpgradeDecision } from './upgrade-router.js';

/**
 * The identity fields the chain resolves for a request (the session gate's
 * `user`, the agent-identity step's `agentIdentity`), resolved for an upgrade.
 */
export interface StreamUpgradeLocals {
  /** Present only when the gate asked for a credential and one verified. */
  user?: RequestUser;
  /** Present only when a valid `X-DorkOS-Agent` token was offered. */
  agentIdentity?: AgentIdentity;
}

/**
 * An upgrade's caller, as the caller policies read a request's facts.
 *
 * @param headers - The upgrade's headers.
 * @param locals - The identity {@link authorizeStreamUpgrade} resolved.
 * @returns The facts the caller policies read.
 */
export function upgradeCaller(
  headers: IncomingHttpHeaders,
  locals: StreamUpgradeLocals
): Pick<RequestFacts, 'headers' | 'user' | 'agentIdentity'> {
  return { headers, user: locals.user, agentIdentity: locals.agentIdentity };
}

/** An authorized upgrade, carrying the identity the handler should act as. */
export interface AuthorizedStreamUpgrade {
  readonly ok: true;
  /** The resolved identity, for `resolveCaller` and the other caller policies. */
  readonly locals: StreamUpgradeLocals;
}

/**
 * An upgrade's facts as the gate policy reads them: its raw headers, its TCP
 * peer and the listener that admitted it.
 *
 * @param req - The upgrade request.
 */
export function upgradeFacts(
  req: Pick<IncomingMessage, 'headers' | 'socket'>
): Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'> {
  return {
    headers: req.headers,
    peerAddress: req.socket.remoteAddress,
    ingress: ingressOf(req as IncomingMessage),
  };
}

/**
 * Run the durable-stream credential gate over an upgrade.
 *
 * @param req - The upgrade request: headers, socket and its ingress mark.
 * @returns The resolved identity, or a `401` refusal for the router to write.
 */
export async function authorizeStreamUpgrade(
  req: Pick<IncomingMessage, 'headers' | 'socket'>
): Promise<AuthorizedStreamUpgrade | Extract<UpgradeDecision, { ok: false }>> {
  const locals: StreamUpgradeLocals = {};
  const { headers } = req;

  const access = gateAccessFor(upgradeFacts(req));
  if (access === 'refused') return { ok: false, status: 401, message: 'Unauthorized' };
  if (access === 'credential') {
    const user = await verifyRequestAuth({ headers });
    if (!user) return { ok: false, status: 401, message: 'Unauthorized' };
    locals.user = user;
  }

  const agentIdentity = await resolveAgentIdentityFromHeaders(headers);
  if (agentIdentity) locals.agentIdentity = agentIdentity;

  return { ok: true, locals };
}
