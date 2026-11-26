/**
 * The `X-DorkOS-Agent` header (spec `agent-trust` §3.1): its name, and whether a
 * request presented it. Pure: it reads headers and nothing else, so a service
 * may ask it as freely as the chain does. Resolving the token to an agent is
 * `middleware/agent-identity.ts`.
 *
 * @module lib/http/agent-identity-header
 */
import type { IncomingHttpHeaders } from 'node:http';

/** What {@link presentsAgentIdentity} reads: a request's raw headers and the identity they resolved to. */
export interface AgentIdentityClaim {
  /** The raw request headers, as Node parsed them (lower-case names). */
  readonly headers: IncomingHttpHeaders;
  /** The agent the header resolved to, or `undefined`. */
  readonly agentIdentity: unknown;
}

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
 * It is a fact about the request, not a decision about it: it rejects nothing. What the surfaces that read it DO with
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
export function presentsAgentIdentity(request: AgentIdentityClaim): boolean {
  return (
    request.agentIdentity !== undefined || request.headers[AGENT_IDENTITY_HEADER] !== undefined
  );
}
