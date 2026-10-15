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
 * Every field is a raw fact, never a framework's interpretation of one. The
 * one exception is {@link RequestFacts.forwardedAddress}, the client address
 * with one proxy hop trusted, which {@link forwardedClientAddress} computes.
 *
 * @module http/request-facts
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { AgentIdentity } from '../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { ingressOf, type RequestIngress } from '../services/core/remote/ingress-mark.js';

/** What a policy may know about one request. */
export interface RequestFacts {
  /** The raw request headers, as Node parsed them (lower-case names). */
  readonly headers: IncomingHttpHeaders;
  /** The TCP peer address. No header can move it. */
  readonly peerAddress: string | undefined;
  /**
   * The client address with ONE proxy hop trusted: the rightmost
   * `X-Forwarded-For` entry, or the peer when there is none. Caller-written on
   * a direct connection, so only a policy the operator opted into
   * (`DORKOS_TRUST_PROXY`) may use it.
   */
  readonly forwardedAddress: string | undefined;
  /** Whether the connection itself is TLS. The server binds plain HTTP, so in practice false. */
  readonly connectionEncrypted: boolean;
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
 * The client address with one proxy hop trusted: what Express reported as
 * `req.ip` under `trust proxy, 1`, which the server ran with until it moved to
 * Hono, so the rate limiters keep the keys they always had.
 *
 * The socket peer is the one trusted hop, so the client is the last
 * `X-Forwarded-For` entry. Entries
 * are split on commas with surrounding spaces dropped, and empty ones skipped;
 * with none left, the client is the peer itself.
 *
 * @param forwardedFor - The raw `X-Forwarded-For` header, if any.
 * @param peerAddress - The TCP peer address.
 * @returns The client address.
 */
export function forwardedClientAddress(
  forwardedFor: string | undefined,
  peerAddress: string | undefined
): string | undefined {
  const entries = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.replace(/^ +| +$/g, ''))
    .filter((entry) => entry !== '');
  return entries.at(-1) ?? peerAddress;
}

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
  // Node joins a repeated `X-Forwarded-For` into one string, so this is never
  // an array at runtime; joining keeps the type honest without a cast.
  const raw = incoming.headers['x-forwarded-for'];
  const forwardedFor = Array.isArray(raw) ? raw.join(', ') : raw;
  return {
    headers: incoming.headers,
    peerAddress: incoming.socket.remoteAddress,
    forwardedAddress: forwardedClientAddress(forwardedFor, incoming.socket.remoteAddress),
    connectionEncrypted: isEncrypted(incoming),
    ingress: ingressOf(incoming),
    user: c.get('user'),
    agentIdentity: c.get('agentIdentity'),
  };
}

/** Whether a request arrived on a TLS socket. */
function isEncrypted(req: Pick<IncomingMessage, 'socket'>): boolean {
  return Boolean((req.socket as TLSSocket | undefined)?.encrypted);
}
