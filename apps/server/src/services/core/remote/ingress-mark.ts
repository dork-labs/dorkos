/**
 * Which listener a request came in on, when it was not the main one.
 *
 * Three listeners besides the main one hand their requests to the same front
 * door (and their upgrades to the same upgrade router): the managed
 * remote-access ingress, the person's own-tunnel ingress, and the Wi-Fi
 * listener. The first two forward from an ngrok agent on loopback, so the
 * socket alone would make a phone on either look like a person at this
 * machine. Each listener marks every request it admits, and the request
 * classifier (`lib/request-classifier.ts`) and `isAtThisComputer` (`services/core/auth/gate-policy.ts`) read the mark,
 * so a marked request is never taken for this computer whatever its `Host` says.
 *
 * `relay` is reserved for the session relay (B2, DOR-2946), which marks what
 * it carries. Nothing sets it yet.
 *
 * Kept on the request object itself (a `WeakMap`, so nothing outlives it) rather
 * than on a framework's context, because a WebSocket upgrade has no response
 * and runs no chain.
 *
 * @module services/core/remote/ingress-mark
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A listener that marks what it admits: everything except the main one. */
export type IngressKind = 'managed' | 'own-tunnel' | 'wifi' | 'relay';

/** Where a request came in: a marked listener, or `direct` for the main one. */
export type RequestIngress = IngressKind | 'direct';

const marks = new WeakMap<IncomingMessage, IngressKind>();

/**
 * Mark a request as having arrived through one of the marked listeners.
 *
 * @param req - The request the listener admitted.
 * @param kind - Which listener.
 */
export function markIngress(req: IncomingMessage, kind: IngressKind): void {
  marks.set(req, kind);
}

/**
 * Which listener a request arrived through.
 *
 * @param req - Any incoming request (an Express request is one too).
 * @returns The marking listener, or `direct` for the main listener.
 */
export function ingressOf(req: IncomingMessage): RequestIngress {
  return marks.get(req) ?? 'direct';
}

/**
 * Whether a request arrived through the managed ingress: the question the
 * managed activity count and the managed host guard ask.
 *
 * @param req - Any incoming request (an Express request is one too).
 */
export function isManagedIngress(req: IncomingMessage): boolean {
  return marks.get(req) === 'managed';
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
 * Called by the session gate once it has let a request
 * through, and by the managed ingress for a path the gate never decides on (a
 * page or asset). A managed request is passed on to the activity count, once;
 * any other request is ignored. So a request counts only after the edge proof
 * (the ingress never marks a refused one) AND, where it applies, the local
 * login gate admitted it.
 *
 * @param req - The admitted request.
 * @param res - Its response, whose `close` ends the request.
 */
export function noteGateAdmitted(req: IncomingMessage, res: ServerResponse): void {
  if (admissionListener === null || !isManagedIngress(req) || admittedRequests.has(req)) return;
  admittedRequests.add(req);
  admissionListener(req, res);
}

/** The client side of an accepted WebSocket, as far as the activity count reads it. */
export interface AdmittedSocket {
  on(event: 'message', listener: () => void): unknown;
}

/** Hears each managed upgrade the upgrade router accepted. See {@link noteUpgradeAdmitted}. */
export type ManagedUpgradeListener = (req: IncomingMessage, socket: AdmittedSocket) => void;

let upgradeListener: ManagedUpgradeListener | null = null;

/**
 * Set who hears managed upgrades the upgrade router accepted: the activity
 * count (`managed-activity.ts`). One listener; `null` removes it.
 *
 * @param listener - The listener, or `null`.
 */
export function setManagedUpgradeListener(listener: ManagedUpgradeListener | null): void {
  upgradeListener = listener;
}

/**
 * Called by the upgrade router once a WebSocket was accepted, after its origin,
 * credential and route checks. A managed one is passed on to the activity
 * count; any other is ignored.
 *
 * @param req - The upgrade request.
 * @param socket - The accepted socket, whose client messages are activity.
 */
export function noteUpgradeAdmitted(req: IncomingMessage, socket: AdmittedSocket): void {
  if (upgradeListener === null || !isManagedIngress(req)) return;
  upgradeListener(req, socket);
}
