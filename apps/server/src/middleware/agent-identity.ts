/**
 * Resolve an agent identity from the `X-DorkOS-Agent` header onto the request
 * context (spec `agent-trust` §3.1).
 *
 * The chain (`http/api-chain.ts`) runs {@link resolveAgentIdentityFromHeaders}
 * right after the session gate, and a WebSocket upgrade runs it for itself
 * (`services/core/streams/stream-upgrade-auth.ts`). It is purely additive: it
 * reads a header, and on success the {@link AgentIdentity} becomes the
 * request's `agentIdentity` (`c.var.agentIdentity`, beside the gate's `user`).
 *
 * ## This step never rejects a request
 *
 * Absent, unknown, malformed, or revoked tokens all fall through to today's
 * unattributed behavior — identity is attribution, not authorization (spec
 * §3.1, resolved open question: mandatory identity would break external MCP
 * clients and human CLI use for no security gain, since transport auth already
 * guards these surfaces). It also does not alter any existing auth outcome:
 * the session gate has already decided whether the request may proceed by the
 * time this runs.
 *
 * @module middleware/agent-identity
 */
import type { IncomingHttpHeaders } from 'node:http';
import {
  agentTokenDigestPrefix,
  getAgentIdentityService,
  type AgentIdentity,
} from '../services/core/agent-identity/agent-identity-service.js';
import { logger } from '../lib/logger.js';
import { AGENT_IDENTITY_HEADER } from '../lib/http/agent-identity-header.js';

/**
 * Resolve `X-DorkOS-Agent` from a set of request headers.
 *
 * One function for both callers because a WebSocket upgrade needs the identical
 * answer and runs no chain: an upgrade arrives on the HTTP server's `upgrade`
 * event, so no middleware runs for it (see
 * `services/core/streams/stream-upgrade-auth.ts`). One implementation rather than
 * two keeps "which token resolves to which agent" a single fact.
 *
 * Never rejects and never throws — identity is attribution, not authorization
 * (spec `agent-trust` §3.1). Costs nothing when the header is absent, which is
 * the overwhelmingly common case.
 *
 * @param headers - The request or upgrade headers.
 * @param context - Where this was read, for the debug line on an unresolvable
 *   token.
 * @returns The resolved identity, or `undefined`.
 */
export async function resolveAgentIdentityFromHeaders(
  headers: IncomingHttpHeaders,
  context = 'upgrade'
): Promise<AgentIdentity | undefined> {
  const header = headers[AGENT_IDENTITY_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return undefined;

  const service = getAgentIdentityService();
  if (!service) return undefined;

  try {
    const trimmed = token.trim();
    const identity = await service.resolve(trimmed);
    if (identity) return identity;
    // A token that goes nowhere is worth seeing: something is presenting a
    // credential this machine has no record of, and without a line here it
    // silently degrades to "unattributed" forever. The digest prefix makes
    // repeat attempts by the SAME token recognizable; the token itself is never
    // logged.
    //
    // This is NO LONGER what a revoked or expired agent looks like (DOR-486) —
    // those resolve to an identity marked `inactive`, and are refused loudly at
    // the gates rather than quietly here. Reaching this line now means a token
    // from no agent at all.
    logger.debug('[agent-identity] Presented token did not resolve', {
      tokenDigestPrefix: agentTokenDigestPrefix(trimmed),
      path: context,
    });
  } catch (err) {
    // A resolution failure must never take the request down with it — the
    // caller simply stays unattributed. Never log the presented token.
    logger.debug('[agent-identity] Token resolution failed', { err: String(err) });
  }
  return undefined;
}
