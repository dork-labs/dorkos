/**
 * Which requests arrived through the managed remote-access ingress.
 *
 * The managed ingress hands its requests to the same Express app (and its
 * upgrades to the same upgrade router) that serve this machine, and its TCP
 * peer is the ngrok agent on loopback. So the socket alone would make a phone
 * on managed remote access look like a person at this machine. The ingress
 * marks every request it admits, and `isLocalCaller` refuses a marked request
 * whatever its `Host` says.
 *
 * Kept on the request object itself (a `WeakSet`, so nothing outlives it) rather
 * than only on `res.locals`, because a WebSocket upgrade has no response and no
 * Express around it.
 *
 * @module services/core/remote/ingress-mark
 */
import type { IncomingMessage } from 'node:http';

const managedRequests = new WeakSet<IncomingMessage>();

/**
 * Mark a request as having arrived through the managed ingress.
 *
 * @param req - The request the ingress admitted.
 */
export function markManagedIngress(req: IncomingMessage): void {
  managedRequests.add(req);
}

/**
 * Whether a request arrived through the managed ingress.
 *
 * @param req - Any incoming request (an Express request is one too).
 */
export function isManagedIngress(req: IncomingMessage): boolean {
  return managedRequests.has(req);
}
