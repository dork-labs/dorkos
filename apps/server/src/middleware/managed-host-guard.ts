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
 * name behave exactly as before. Asked second in the chain (`http/api-chain.ts`),
 * ahead of every logger and route, and by the upgrade router for WebSockets.
 *
 * @module middleware/managed-host-guard
 */
import type { IncomingMessage } from 'node:http';
import { parseHostname } from '../lib/trusted-origins.js';
import { isManagedIngress } from '../services/core/remote/ingress-mark.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';

/** The refusal. */
export const MANAGED_HOST_REFUSAL_BODY = { error: 'Forbidden.' } as const;

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
