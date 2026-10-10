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
import type { IncomingMessage, ServerResponse } from 'node:http';

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

/** Hears each managed request the session gate let through. See {@link noteGateAdmitted}. */
export type ManagedAdmissionListener = (req: IncomingMessage, res: ServerResponse) => void;

let admissionListener: ManagedAdmissionListener | null = null;
const admittedRequests = new WeakSet<IncomingMessage>();

/**
 * Set who hears managed requests the session gate admitted: the activity
 * count (`managed-activity.ts`). One listener; `null` removes it.
 *
 * @param listener - The listener, or `null`.
 */
export function setManagedAdmissionListener(listener: ManagedAdmissionListener | null): void {
  admissionListener = listener;
}

/**
 * Called by the session gate (Express and Hono alike) once it has let a request
 * through. A managed request is passed on to the activity count, once; any
 * other request is ignored. So a request counts only after the edge proof (the
 * ingress never marks a refused one) AND the local login gate admitted it.
 *
 * @param req - The admitted request.
 * @param res - Its response, whose `close` ends the request.
 */
export function noteGateAdmitted(req: IncomingMessage, res: ServerResponse): void {
  if (admissionListener === null || !isManagedIngress(req) || admittedRequests.has(req)) return;
  admittedRequests.add(req);
  admissionListener(req, res);
}
