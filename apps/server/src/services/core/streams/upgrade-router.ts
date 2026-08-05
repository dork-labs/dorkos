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
import { resolveTrustedOrigins } from '../../../lib/trusted-origins.js';
import { logger } from '../../../lib/logger.js';

/** What a route is given to decide on an upgrade, before any socket is bound. */
export interface UpgradeAttempt {
  /** The request URL, parsed — `pathname` for routing, `searchParams` for options. */
  readonly url: URL;
  /** The upgrade request's headers, carrying credentials and `Origin`. */
  readonly headers: IncomingHttpHeaders;
  /** The route pattern's match against the pathname, for captured ids. */
  readonly match: RegExpExecArray;
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
   * Authorize the claimed upgrade. Every credential check a route needs lives
   * here, because none of Express's ran (see the module doc). Returning a
   * refusal is how a route answers 401/403/404 — throwing is a bug and closes
   * the socket with no status.
   */
  authorize(attempt: UpgradeAttempt): UpgradeDecision | Promise<UpgradeDecision>;
}

/**
 * Whether a browser-supplied `Origin` may open a socket here.
 *
 * WebSocket handshakes are NOT subject to CORS: a page on any origin can open a
 * socket to any host its user can reach, and the browser will attach that
 * host's cookies. The `Origin` header is the only thing distinguishing a
 * cockpit tab from a hostile page that DNS-rebound onto this port, so it is
 * checked against the same allowlist the CORS policy and `validateMcpOrigin`
 * use. Non-browser clients (the CLI, the desktop shell, tests) send no `Origin`
 * and pass through — exactly as they do at the MCP origin middleware, and for
 * the same reason: a header a browser is forced to send truthfully proves
 * nothing when absent.
 *
 * @param origin - The upgrade request's `Origin` header, if any.
 */
function isTrustedUpgradeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return resolveTrustedOrigins().includes(origin);
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

    if (!isTrustedUpgradeOrigin(req.headers.origin)) {
      refuse(socket, 403, 'Forbidden');
      return;
    }

    void (async () => {
      let decision: UpgradeDecision;
      try {
        decision = await claimed.route.authorize({
          url,
          headers: req.headers,
          match: claimed.match,
        });
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
