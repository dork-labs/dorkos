/**
 * The own-tunnel ingress: a loopback-only HTTP listener the person's own ngrok
 * tunnel forwards into, and that hands every request to the front door's
 * listener and every upgrade to the main server's upgrade router.
 *
 * A listener of its own, rather than forwarding straight at the main port,
 * because that is the only way to know for certain which requests came through
 * the tunnel. The ngrok agent connects from loopback, so at the main port a
 * tunnel request whose `Host` was rewritten to `localhost`
 * (`--host-header=rewrite`, or any future option that does the same) would look
 * like a person at this machine. Here every request and upgrade is marked
 * `own-tunnel` (`ingress-mark.ts`) before anything else runs, and the request
 * classifier and `isAtThisComputer` read the mark.
 *
 * It checks nothing else: an own tunnel has no edge proof, and its requests
 * meet the same host guard, login gate and routes as any other. That is the
 * difference from the managed ingress (`managed-ingress.ts`), which runs the
 * edge-proof and host checks first.
 *
 * It fronts only the main server's own port. In development the app is served
 * by the Vite server, which the front door does not serve, so a tunnel aimed
 * there (or at an operator's `TUNNEL_PORT`) forwards directly, as before; its
 * requests still classify as another device by the `X-Forwarded-For` ngrok adds.
 *
 * @module services/core/remote/own-tunnel-ingress
 */
import http, { type IncomingMessage, type RequestListener } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { markIngress } from './ingress-mark.js';

/** Where the own-tunnel ingress hands what it marks. */
export interface OwnTunnelIngressOptions {
  /** The main server's request listener: its front door. */
  handler: RequestListener;
  /** Hand an upgrade to the main server's upgrade router. */
  forwardUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** The main server's configured port (`DORKOS_PORT`). */
  frontedPort: number;
}

/** The own-tunnel ingress listener. One per process; owned by `TunnelManager`. */
export interface OwnTunnelIngress {
  /**
   * Whether a tunnel aimed at `port` should forward here instead: true only for
   * the main server's own port, the one whose front door this hands to.
   *
   * @param port - The port the tunnel was asked to forward.
   */
  fronts(port: number): boolean;
  /**
   * Start listening on `127.0.0.1` at a free port, or reuse the open listener.
   *
   * @returns The address to forward to, `http://127.0.0.1:<port>`.
   */
  open(): Promise<string>;
  /** Stop listening and cut every connection it carried, upgraded ones included. */
  close(): Promise<void>;
}

/**
 * The production own-tunnel ingress, in front of the main server.
 *
 * @param handler - The main server's request listener.
 * @param server - The main server, whose `upgrade` listener is the upgrade router.
 * @param port - The main server's configured port.
 */
export function ownTunnelIngressFor(
  handler: RequestListener,
  server: http.Server,
  port: number
): OwnTunnelIngress {
  return createOwnTunnelIngress({
    handler,
    forwardUpgrade: (req, socket, head) => server.emit('upgrade', req, socket, head),
    frontedPort: port,
  });
}

/**
 * Create the own-tunnel ingress. Nothing listens until {@link OwnTunnelIngress.open}.
 *
 * @param options - Where marked traffic goes, and which port it fronts.
 */
export function createOwnTunnelIngress(options: OwnTunnelIngressOptions): OwnTunnelIngress {
  let server: http.Server | null = null;
  let opening: Promise<string> | null = null;
  const connections = new Set<Socket>();

  function listen(): Promise<string> {
    const next = http.createServer((req, res) => {
      markIngress(req, 'own-tunnel');
      options.handler(req, res);
    });
    next.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      markIngress(req, 'own-tunnel');
      options.forwardUpgrade(req, socket, head);
    });
    next.on('connection', (socket: Socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    });
    return new Promise((resolve, reject) => {
      next.once('error', reject);
      next.listen(0, '127.0.0.1', () => {
        next.off('error', reject);
        server = next;
        resolve(`http://127.0.0.1:${(next.address() as AddressInfo).port}`);
      });
    });
  }

  return {
    fronts(port) {
      return options.frontedPort === port;
    },
    open() {
      if (server)
        return Promise.resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      opening ??= listen().finally(() => {
        opening = null;
      });
      return opening;
    },
    async close() {
      await opening?.catch(() => undefined);
      const closing = server;
      server = null;
      if (!closing) return;
      const closed = new Promise<void>((resolve) => closing.close(() => resolve()));
      // Upgraded sockets are not tracked by `closeAllConnections`; cut them too.
      for (const socket of connections) socket.destroy();
      connections.clear();
      closing.closeAllConnections();
      await closed;
    },
  };
}
