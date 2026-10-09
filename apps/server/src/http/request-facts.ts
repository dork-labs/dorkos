/**
 * One framework-free picture of an HTTP request, for the policies that decide
 * who a caller is and what they may do: credential checks, the browser-origin
 * policy, rate-limit keys and the caller-authority bars.
 *
 * During the move from Express to Hono (ADR `261009-192542`) a request runs
 * exactly one middleware chain, Express's or Hono's, and both chains must ask
 * the SAME policy functions. Those functions used to take an Express `Request`
 * and read `res.locals`. They now read a {@link RequestFacts}, and each
 * framework has one adapter that builds it: {@link expressRequestFacts} and
 * {@link honoRequestFacts}. A policy can then not tell, and cannot come to
 * depend on, which chain asked.
 *
 * Every field is a raw fact, never a framework's interpretation of one. The
 * one exception is {@link RequestFacts.forwardedAddress}, which is Express's
 * `req.ip` exactly as `trust proxy, 1` computes it; the Hono adapter computes
 * the same value with {@link forwardedClientAddress}, and a test holds the two
 * to each other.
 *
 * @module http/request-facts
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Request, Response } from 'express';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { AgentIdentity } from '../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';

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
  /** The identity the session gate proved, when it ran and proved one. */
  readonly user: RequestUser | undefined;
  /** The agent the `X-DorkOS-Agent` middleware resolved, when one did. */
  readonly agentIdentity: AgentIdentity | undefined;
}

/**
 * The Hono variables the identity middleware sets, under the same names the
 * Express chain uses on `res.locals`.
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
 * The client address Express reports as `req.ip` under `trust proxy, 1`.
 *
 * Express (through `proxy-addr` and `forwarded`) treats the socket peer as the
 * one trusted hop, so the client is the last `X-Forwarded-For` entry. Entries
 * are split on commas with surrounding spaces dropped, and empty ones skipped;
 * with none left, the client is the peer itself.
 *
 * @param forwardedFor - The raw `X-Forwarded-For` header, if any.
 * @param peerAddress - The TCP peer address.
 * @returns The address Express would report as `req.ip`.
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
 * The facts of an Express request.
 *
 * @param req - The Express request.
 * @param res - Its response, for what the identity middleware put on
 *   `res.locals`. Omit it where no identity has been resolved yet (the CORS
 *   delegate, a rate limiter's key).
 * @returns The request's facts.
 */
export function expressRequestFacts(req: Request, res?: Pick<Response, 'locals'>): RequestFacts {
  return {
    headers: req.headers,
    peerAddress: req.socket.remoteAddress,
    forwardedAddress: req.ip,
    connectionEncrypted: isEncrypted(req),
    user: res?.locals.user as RequestUser | undefined,
    agentIdentity: res?.locals.agentIdentity as AgentIdentity | undefined,
  };
}

/**
 * The facts of a Hono request served through `@hono/node-server`.
 *
 * Reads the raw Node request rather than `c.req`, so the headers are the same
 * object shape Express hands its policies, duplicates joined the same way.
 *
 * @param c - The Hono context.
 * @returns The request's facts.
 */
export function honoRequestFacts(c: Context<RequestFactsEnv>): RequestFacts {
  const incoming = c.env.incoming;
  // Node joins a repeated `X-Forwarded-For` into one string; the array case is
  // only the header type's, kept honest the way `forwarded` would read it.
  const raw = incoming.headers['x-forwarded-for'];
  const forwardedFor = Array.isArray(raw) ? raw.join(', ') : raw;
  return {
    headers: incoming.headers,
    peerAddress: incoming.socket.remoteAddress,
    forwardedAddress: forwardedClientAddress(forwardedFor, incoming.socket.remoteAddress),
    connectionEncrypted: isEncrypted(incoming),
    user: c.get('user'),
    agentIdentity: c.get('agentIdentity'),
  };
}

/** Whether a request arrived on a TLS socket. */
function isEncrypted(req: Pick<IncomingMessage, 'socket'>): boolean {
  return Boolean((req.socket as TLSSocket | undefined)?.encrypted);
}
