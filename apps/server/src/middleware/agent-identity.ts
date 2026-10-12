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
import type { RequestFacts } from '../http/request-facts.js';

/** The header an agent presents its minted identity token in. */
export const AGENT_IDENTITY_HEADER = 'x-dorkos-agent';

/**
 * Whether this request claims to be a machine at all — resolved or not.
 *
 * The wider question than the resolved `agentIdentity`, and a different one:
 * that answers "WHICH agent is this", which needs a token that verified;
 * this answers "is a machine calling", which a token that did NOT verify still
 * says. A revoked or expired agent is still an agent, and a person in the
 * cockpit never sends this header at all.
 *
 * It is a fact about the request, not a decision about it — this module still
 * rejects nothing (see the module doc). What the surfaces that read it DO with
 * the answer is theirs: `lib/caller-authority.ts` feeds it to
 * `resolveDecisionAuthority` as `agentIdentityPresented`, and
 * `routes/room-caller.ts` refuses on it outright, which is what makes every room
 * route refuse a token it cannot verify (DOR-1357, widened by DOR-1361). It
 * lives here, in the module that owns the header, so those two cannot come to
 * mean different things by "an agent presented itself".
 *
 * **An EMPTY `X-DorkOS-Agent:` counts as presented**, and on the room seams that
 * is a hard 401 rather than a fall-through to the operator. Deliberate: the
 * header is there, so something meant to identify itself as a machine and
 * failed, which is exactly the case this predicate is for. No first-party client
 * can produce it — the CLI attaches the header only when `DORKOS_AGENT_TOKEN`
 * holds a truthy value (`packages/cli/src/lib/api-client.ts`) and the cockpit
 * never sends it at all — so the only caller that reaches it is one hand-rolling
 * requests, for which the strict answer is the useful one.
 *
 * @param request - The request's facts (`http/request-facts.ts`), for the raw
 *   header and whatever resolved from it.
 * @returns True when the header was present, however it resolved.
 */
export function presentsAgentIdentity(
  request: Pick<RequestFacts, 'headers' | 'agentIdentity'>
): boolean {
  return (
    request.agentIdentity !== undefined || request.headers[AGENT_IDENTITY_HEADER] !== undefined
  );
}

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
