/**
 * The transport half of a request's facts: what the connection and its
 * headers say, before any server decides who the caller is.
 *
 * A server's policies (credential checks, the browser-origin policy, rate-limit
 * keys) read facts, never a framework's request, so a policy cannot tell, and
 * cannot come to depend on, which surface asked. Each server adds its own
 * identity facts on top of these (the DorkOS app adds the listener, the signed-in
 * person and the calling agent in `apps/server/src/http/request-facts.ts`).
 *
 * Every field is a raw fact, never a framework's interpretation of one. The one
 * exception is {@link TransportFacts.forwardedAddress}, the client address with
 * one proxy hop trusted, which {@link forwardedClientAddress} computes.
 *
 * @module http-kit/request-facts
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';

/** What the connection and its headers say about one request. */
export interface TransportFacts {
  /** The raw request headers, as Node parsed them (lower-case names). */
  readonly headers: IncomingHttpHeaders;
  /** The TCP peer address. No header can move it. */
  readonly peerAddress: string | undefined;
  /**
   * The client address with ONE proxy hop trusted: the rightmost
   * `X-Forwarded-For` entry, or the peer when there is none. Caller-written on
   * a direct connection, so only a policy the operator opted into may use it.
   */
  readonly forwardedAddress: string | undefined;
  /** Whether the connection itself is TLS. */
  readonly connectionEncrypted: boolean;
  /** The request method, when the surface knows it. */
  readonly method?: string;
}

/**
 * The client address with one proxy hop trusted: what Express reported as
 * `req.ip` under `trust proxy, 1`, which the DorkOS app ran with until it moved
 * to Hono, so its rate limiters keep the keys they always had.
 *
 * The socket peer is the one trusted hop, so the client is the last
 * `X-Forwarded-For` entry. Entries are split on commas with surrounding spaces
 * dropped (spaces only: a tab is kept, as Express kept it), and empty ones
 * skipped; with none left, the client is the peer itself.
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
 * The transport facts of a raw Node request.
 *
 * Reads Node's own header object (lower-case names, duplicates joined the way
 * Node joins them), never a framework's copy.
 *
 * @param incoming - The raw Node request.
 * @param method - The request method, when the caller knows it.
 * @returns The request's transport facts.
 */
export function nodeTransportFacts(
  incoming: Pick<IncomingMessage, 'headers' | 'socket'>,
  method?: string
): TransportFacts {
  // Node joins a repeated `X-Forwarded-For` into one string, so this is never
  // an array at runtime; joining keeps the type honest without a cast.
  const raw = incoming.headers['x-forwarded-for'];
  const forwardedFor = Array.isArray(raw) ? raw.join(', ') : raw;
  const peerAddress = incoming.socket.remoteAddress;
  return {
    headers: incoming.headers,
    peerAddress,
    forwardedAddress: forwardedClientAddress(forwardedFor, peerAddress),
    connectionEncrypted: Boolean((incoming.socket as TLSSocket | undefined)?.encrypted),
    ...(method === undefined ? {} : { method }),
  };
}
