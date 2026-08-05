/**
 * The server's single WebSocket upgrade entry point.
 *
 * Node emits `upgrade` on the HTTP server, not through Express, so **no Express
 * middleware runs for an upgrade** — not the CORS policy, not the host guard,
 * and critically not {@link sessionGate}. Anything an upgrade needs from that
 * stack has to be asked for explicitly, which is what a {@link UpgradeRoute}'s
 * `authorize` does.
 *
 * It is a router rather than a handler because `server.on('upgrade')` is a
 * plain EventEmitter: every listener sees every upgrade, and the previous
 * single listener (the terminal's) destroyed any socket whose path it did not
 * recognize. A second listener registered beside it would therefore have had
 * its sockets killed by the first. One router that claims by path is the only
 * arrangement in which two upgrade consumers can coexist.
 *
 * @module services/core/streams/upgrade-router
 */
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';
import {
  isTrustedUpgradeOrigin,
  parseHostname,
  getTunnelHost,
} from '../../../lib/trusted-origins.js';
import { isHostAllowed, parseTrustedHosts } from '../../../middleware/host-guard.js';
import { configManager } from '../config-manager.js';
import { env } from '../../../env.js';
import { authorizeStreamUpgrade, type StreamUpgradeLocals } from './stream-upgrade-auth.js';
import { logger } from '../../../lib/logger.js';

/** What a route is given to decide on an upgrade, before any socket is bound. */
export interface UpgradeAttempt {
  /** The request URL, parsed — `pathname` for routing, `searchParams` for options. */
  readonly url: URL;
  /** The upgrade request's headers, carrying credentials and `Origin`. */
  readonly headers: IncomingHttpHeaders;
  /** The route pattern's match against the pathname, for captured ids. */
  readonly match: RegExpExecArray;
  /**
   * The identity the router already resolved, `res.locals`-shaped so
   * `resolveCaller` and `getRequestAgentIdentity` read it unchanged.
   *
   * Empty for a route whose `credential` is `bearer-of-id`.
   */
  readonly locals: StreamUpgradeLocals;
}

/** A route's answer: bind the socket, or refuse with an HTTP status. */
export type UpgradeDecision =
  /** Allowed — `open` runs once the handshake has completed. */
  | { readonly ok: true; readonly open: (socket: WebSocket) => void }
  /** Refused, with the status and how the client is told. */
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      /**
       * How the refusal reaches the client. Defaults to `handshake`.
       *
       * `handshake` writes the status onto the raw socket and destroys it — the
       * cheapest answer, and the right one when nothing needs to tell the
       * reasons apart.
       *
       * `close-frame` completes the handshake and immediately closes with
       * `4000 + status`, because a BROWSER cannot read the status of a failed
       * handshake at all (see {@link STREAM_CLOSE_CODE_BASE}). The durable
       * streams use it: the room stream retries a transient failure forever but
       * must stop when the server says the room is not this reader's to read,
       * and that distinction is only a status.
       */
      readonly deliver?: 'handshake' | 'close-frame';
    };

/** One claimant on the upgrade path. */
export interface UpgradeRoute {
  /** Name used in logs when this route refuses or throws. */
  readonly name: string;
  /**
   * Claims an upgrade whose pathname it matches. Patterns are tried in
   * registration order and the first match wins, so a route must not match a
   * path another route owns.
   */
  readonly pattern: RegExp;
  /**
   * How this route is authenticated — decided by the ROUTER, before `authorize`
   * runs, so that a new route cannot forget it.
   *
   * That is the whole point of it living here. When each route called the
   * credential gate itself, deleting those three calls left the entire server
   * suite green: the gate was tested, but the *wiring* of it — the part an
   * exploit uses — was not. A route now states its posture as data, and
   * `__tests__/upgrade-router.test.ts` pins that `required` really refuses.
   *
   * - `required` — must present a valid session cookie or per-user API key when
   *   login is enabled, exactly as `sessionGate` demands of a request. The
   *   durable streams.
   * - `bearer-of-id` — authorized by holding an unguessable id minted by an
   *   already-gated route, and `authorize` checks that id itself. The terminal
   *   (ADR 260708-185521).
   */
  readonly credential: 'required' | 'bearer-of-id';
  /**
   * Authorize the claimed upgrade. Every credential check a route needs lives
   * here, because none of Express's ran (see the module doc). Returning a
   * refusal is how a route answers 401/403/404 — throwing is a bug and closes
   * the socket with no status.
   */
  authorize(attempt: UpgradeAttempt): UpgradeDecision | Promise<UpgradeDecision>;
}

/**
 * Resolve the facts the origin policy needs and ask it.
 *
 * WebSocket handshakes are NOT subject to CORS: a page on any origin can open a
 * socket to any host its user can reach, and the browser attaches that host's
 * cookies. `Origin` is the only thing separating a cockpit tab from a page that
 * DNS-rebound onto this port. The policy itself — and why it is not a bare
 * allowlist — lives in {@link isTrustedUpgradeOrigin}.
 *
 * @param headers - The upgrade request's headers.
 */
function originIsTrusted(headers: IncomingHttpHeaders): boolean {
  // Mirrors `hostGuard`: with login on, auth cookies are origin-scoped and a
  // rebound origin never presents one; the container escape hatch declares that
  // the surrounding environment owns the boundary.
  const hostCheckInert =
    configManager.get('auth')?.enabled === true || env.DORKOS_ALLOW_INSECURE_BIND === true;

  return isTrustedUpgradeOrigin({
    origin: headers.origin,
    hostHeader: headers.host,
    hostAllowed: isHostAllowed({
      hostname: parseHostname(headers.host),
      trustedHosts: parseTrustedHosts(env.DORKOS_TRUSTED_HOSTS),
      tunnelHost: getTunnelHost(),
    }),
    // eslint-disable-next-line no-restricted-syntax -- DORKOS_CORS_ORIGIN is not in env.ts; read the same way app.ts reads it
    configuredOrigins: process.env.DORKOS_CORS_ORIGIN,
    publicUrl: env.DORKOS_PUBLIC_URL,
    hostCheckInert,
  });
}

/** Write a bare HTTP status onto the un-upgraded socket, then destroy it. */
function refuse(socket: Duplex, status: number, message: string): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  }
  socket.destroy();
}

/**
 * Attach the one `upgrade` listener this server has, serving `routes` in order.
 *
 * An upgrade no route claims is destroyed silently: it is not addressed to us,
 * and answering it would only tell a scanner what is here.
 *
 * @param server - The HTTP server to attach to.
 * @param routes - The claimants, in precedence order.
 */
export function attachUpgradeRouter(server: Server, routes: readonly UpgradeRoute[]): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // `req.url` is origin-form (`/api/...`); the base only satisfies the parser
    // and is never read.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const claimed = routes
      .map((route) => ({ route, match: route.pattern.exec(url.pathname) }))
      .find((candidate): candidate is { route: UpgradeRoute; match: RegExpExecArray } =>
        Boolean(candidate.match)
      );

    if (!claimed) {
      socket.destroy();
      return;
    }

    /**
     * How a refusal reaches THIS route's client.
     *
     * A credential-gated route talks to a browser, which cannot read the status
     * of a failed handshake at all — so its refusals ride a close frame. That
     * matters most for the origin refusal below: delivered at the handshake it
     * was invisible, and a refused stream simply retried five times and landed
     * in `disconnected` with nothing saying why. A loopback-only allowlist then
     * read as "the app is broken" rather than "this origin is not trusted".
     */
    const deliver = claimed.route.credential === 'required' ? 'close-frame' : 'handshake';

    void (async () => {
      /** Resolve the decision; every refusal path returns one rather than replying. */
      const decide = async (): Promise<UpgradeDecision> => {
        if (!originIsTrusted(req.headers)) {
          logger.warn('[ws] refused an upgrade from an untrusted Origin', {
            route: claimed.route.name,
            origin: req.headers.origin,
            host: req.headers.host,
          });
          return { ok: false, status: 403, message: 'Origin not trusted', deliver };
        }

        // The credential gate runs HERE rather than inside each route, so a new
        // route cannot forget it — see `UpgradeRoute.credential`.
        let locals: StreamUpgradeLocals = {};
        if (claimed.route.credential === 'required') {
          const auth = await authorizeStreamUpgrade(req.headers);
          if (!auth.ok) return { ...auth, deliver };
          locals = auth.locals;
        }

        return claimed.route.authorize({
          url,
          headers: req.headers,
          match: claimed.match,
          locals,
        });
      };

      let decision: UpgradeDecision;
      try {
        decision = await decide();
      } catch (err) {
        logger.warn('[ws] upgrade authorization threw', {
          route: claimed.route.name,
          error: err instanceof Error ? err.message : String(err),
        });
        refuse(socket, 500, 'Internal Server Error');
        return;
      }

      if (!decision.ok && (decision.deliver ?? 'handshake') === 'handshake') {
        refuse(socket, decision.status, decision.message);
        return;
      }
      // `authorize` may have awaited (a credential check hits the auth store),
      // and the client can give up inside that window. A browser sends no
      // frames before the 101, so nothing is lost by checking here rather than
      // pausing the socket for the duration.
      if (socket.destroyed) return;

      wss.handleUpgrade(req, socket, head, (ws) => {
        if (decision.ok) {
          decision.open(ws);
          return;
        }
        ws.close(STREAM_CLOSE_CODE_BASE + decision.status, decision.message);
      });
    })();
  });
}
