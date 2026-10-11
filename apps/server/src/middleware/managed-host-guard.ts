/**
 * Refuse a request that names a managed remote-access hostname but did not come
 * through the managed ingress.
 *
 * The contract requires the edge proof on **every** request that arrives over
 * managed access — on the managed listener, or whose `Host` is one of the
 * credential's hostnames. The managed ingress checks the first kind. This
 * closes the second: managed hostnames join the trusted hosts and origins, so
 * without it a request on the main listener carrying `Host: <managed name>`
 * would be trusted as tunnel traffic while never having shown a proof.
 *
 * Only managed hostnames are affected; the person's own tunnel and every local
 * name behave exactly as before. Mounted first in `createApp`, ahead of every
 * logger and route, and asked by the upgrade router for WebSockets.
 *
 * @module middleware/managed-host-guard
 */
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { parseHostname } from '../lib/trusted-origins.js';
import { isManagedIngress } from '../services/core/remote/ingress-mark.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';

/**
 * Whether a request names a managed hostname without having come through the
 * managed ingress.
 *
 * @param req - Any incoming request or upgrade.
 */
export function bypassesManagedIngress(req: IncomingMessage): boolean {
  if (isManagedIngress(req)) return false;
  // Defensive read: many test files mock the tunnel manager as `{ status }`.
  const managedHosts = (tunnelManager as { managedHosts?: readonly string[] }).managedHosts ?? [];
  if (managedHosts.length === 0) return false;
  const hostname = parseHostname(req.headers.host);
  return hostname !== null && managedHosts.includes(hostname);
}

/**
 * Express middleware form of {@link bypassesManagedIngress}: a 403 before any
 * other handling.
 *
 * @param req - The incoming request.
 * @param res - The response; a refusal is a 403.
 * @param next - Passes control on for every other request.
 */
export function managedHostGuard(req: Request, res: Response, next: NextFunction): void {
  if (bypassesManagedIngress(req)) {
    res.status(403).json({ error: 'Forbidden.' });
    return;
  }
  next();
}
