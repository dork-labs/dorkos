/**
 * The two loopback ingresses ngrok forwards into, built together in front of
 * the main server: the managed remote-access ingress (`managed-ingress.ts`) and
 * the person's own-tunnel ingress (`own-tunnel-ingress.ts`). One call, so the
 * server's startup wires both in one place and `TunnelManager` owns both.
 *
 * @module services/core/remote/tunnel-ingresses
 */
import type http from 'node:http';
import { managedIngressFor, type ManagedIngress } from './managed-ingress.js';
import { ownTunnelIngressFor, type OwnTunnelIngress } from './own-tunnel-ingress.js';

/** Both ingresses, for `TunnelManager.attachIngresses`. */
export interface TunnelIngresses {
  /** Where managed remote access forwards. */
  managed: ManagedIngress;
  /** Where the person's own tunnel forwards, when it targets the main server. */
  ownTunnel: OwnTunnelIngress;
}

/**
 * Build both ingresses in front of the main server. Neither listens yet.
 *
 * @param handler - The main server's request listener (its front door).
 * @param server - The main server, whose `upgrade` listener is the upgrade router.
 */
export function tunnelIngressesFor(
  handler: http.RequestListener,
  server: http.Server
): TunnelIngresses {
  return {
    managed: managedIngressFor(handler, server),
    ownTunnel: ownTunnelIngressFor(handler, server),
  };
}
