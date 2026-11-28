/**
 * One framework-free picture of an HTTP request, for the policies that decide
 * who a caller is and what they may do: credential checks, the browser-origin
 * policy, rate-limit keys and the caller-authority bars.
 *
 * The policies read a {@link RequestFacts}, never a framework's request: a
 * route builds them with {@link honoRequestFacts}, and a WebSocket upgrade,
 * which runs no chain, from its headers and the identity it resolved itself.
 * A policy can then not tell, and cannot come to depend on, which surface
 * asked. (They were built this way during the move from Express to Hono,
 * ADR `261009-192542`, so that both chains asked the same functions.)
 *
 * The transport half (headers, peer, the forwarded address, TLS, method) is
 * `@dorkos/http-kit`'s, shared with every server; this module adds the facts
 * only this server's chain knows.
 *
 * @module http/request-facts
 */
import { nodeTransportFacts, type TransportFacts } from '@dorkos/http-kit';
import type { Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import type { AgentIdentity } from '../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { ingressOf, type RequestIngress } from '../services/core/remote/ingress-mark.js';

/**
 * What a policy may know about one request: the transport facts every server
 * shares (`@dorkos/http-kit`), plus which listener admitted it and who the
 * chain proved the caller to be.
 */
export interface RequestFacts extends TransportFacts {
  /**
   * Which listener admitted this request: `direct` for the main one, otherwise
   * the marked listener (managed remote access, the own tunnel, Wi-Fi). The two
   * ngrok ones forward from loopback, so a policy deciding whether a person is
   * at this machine must read this, never the peer alone.
   */
  readonly ingress: RequestIngress;
  /** The identity the session gate proved, when it ran and proved one. */
  readonly user: RequestUser | undefined;
  /** The agent the `X-DorkOS-Agent` middleware resolved, when one did. */
  readonly agentIdentity: AgentIdentity | undefined;
}

/**
 * The Hono variables the chain's identity steps set (`http/api-chain.ts`): the
 * session gate's `user` and the agent-identity step's `agentIdentity`. Every
 * policy reads them through {@link honoRequestFacts}.
 */
export interface RequestFactsVariables {
  /** Set by the session gate. */
  user?: RequestUser;
  /** Set by the agent-identity middleware. */
  agentIdentity?: AgentIdentity;
}

/** The Hono environment {@link honoRequestFacts} reads. */
export type RequestFactsEnv = {
  Bindings: HttpBindings;
  Variables: RequestFactsVariables;
};

/**
 * The facts of a Hono request served through `@hono/node-server`.
 *
 * Reads the raw Node request rather than `c.req`, so the headers are Node's
 * own object (lower-case names, duplicates joined the way Node joins them).
 *
 * @param c - The Hono context.
 * @returns The request's facts.
 */
export function honoRequestFacts(c: Context<RequestFactsEnv>): RequestFacts {
  const incoming = c.env.incoming;
  return {
    // A person-only bar at this computer asks for the person's session only on
    // a change, never a read (`personSessionRequired`, DOR-3330); a surface
    // that does not know the method is treated as a change.
    ...nodeTransportFacts(incoming, c.req.method),
    ingress: ingressOf(incoming),
    user: c.get('user'),
    agentIdentity: c.get('agentIdentity'),
  };
}

/**
 * The facts of a WebSocket upgrade, which runs no chain: its transport facts
 * and ingress, read off the raw request as {@link honoRequestFacts} reads them,
 * plus the identity the upgrade's own credential gate resolved
 * (`services/core/streams/stream-upgrade-auth.ts`). A policy then reads an
 * upgrade exactly as it reads a request. The method is `GET`, the method every
 * upgrade carries.
 *
 * @param incoming - The upgrade request.
 * @param identity - What the upgrade's credential gate resolved.
 * @returns The upgrade's facts.
 */
export function upgradeRequestFacts(
  incoming: IncomingMessage,
  identity: Partial<Pick<RequestFacts, 'user' | 'agentIdentity'>>
): RequestFacts {
  return {
    ...nodeTransportFacts(incoming, 'GET'),
    ingress: ingressOf(incoming),
    user: identity.user,
    agentIdentity: identity.agentIdentity,
  };
}
