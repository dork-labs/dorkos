/**
 * The server's front door: how a raw Node request reaches the one Hono app
 * every HTTP request enters through (`http/hono-api.ts`, ADR `261009-192542`).
 *
 * Four choices keep the server answering as it did before Hono. Each one a
 * request can observe is pinned by `__tests__/front-door.test.ts`:
 *
 * - **A request the adapter cannot read still runs the chain.** The Node
 *   adapter builds a URL from `Host` and answers a bare 400 when it cannot: no
 *   `Host` (HTTP/1.0), a port out of range, a `Host` with a path in it,
 *   `OPTIONS *`. {@link frontDoorListener} builds that request itself on a
 *   placeholder origin instead, leaving the raw `Host` as it came, so the host
 *   guard and every route judge it as they judge any other. A `Host` in
 *   capitals, which the adapter would also refuse, is lower-cased first.
 * - **`overrideGlobalObjects: false`.** By default the adapter swaps the
 *   process-wide `Request` and `Response` for its own lightweight classes.
 *   Better Auth, the MCP SDK and every `fetch` caller in the server build those
 *   objects too, and must keep getting the platform's own.
 * - **`autoCleanupIncoming: false`.** By default the adapter reads and throws
 *   away a body the handler never read, and cuts the connection after 500 ms.
 *   Node already discards an unread body itself and keeps the connection, which
 *   is what a route that refuses before reading an upload relies on.
 * - **A route that writes the Node response itself** (an event stream, a file,
 *   an extension router) answers with the adapter's already-sent marker, and
 *   the adapter writes nothing more (`http/raw-node-stream.ts`).
 *
 * WebSocket upgrades never pass through here: Node emits `upgrade` on the
 * server, not as a request, and `attachUpgradeRouter` claims it there.
 *
 * One thing it adds: a request that names this computer on the network while
 * Wi-Fi access is open has its sign-in cookies adapted to plain `http`, on the
 * way in and out, upgrades included (`adaptLanCookies`, DOR-2930).
 *
 * @module http/front-door
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import { getRequestListener, RequestError, type HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import type { ApiEnv } from './api-chain.js';
import { adaptLanCookies } from '../services/core/lan-access/lan-cookies.js';
import { markIngress, type IngressKind } from '../services/core/remote/ingress-mark.js';

/**
 * The origin a request the adapter cannot read is given, so it has a URL at
 * all. `.invalid` is reserved (RFC 2606) and names no host anyone can own. The
 * request's raw `Host` header is left as it arrived; nothing that decides
 * trust reads this URL's host.
 */
const UNREADABLE_ORIGIN = 'http://unreadable-host.invalid';

/**
 * The Node request listener for the server's Hono app.
 *
 * @param app - The app every request enters (`composeFrontDoor` in
 *   `http/hono-api.ts`).
 * @returns A Node request listener.
 */
export function frontDoorListener(app: Hono<ApiEnv>): RequestListener {
  // The adapter reports an unreadable request to `errorHandler` with only the
  // error, synchronously inside the listener call. This carries the raw pair
  // to it, so the adapter's own judgement decides what it cannot read.
  const raw = new AsyncLocalStorage<[IncomingMessage, ServerResponse]>();
  const viaHono = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: false,
    errorHandler: async (error) => {
      const pair = raw.getStore();
      if (!(error instanceof RequestError) || !pair) return new Response(null, { status: 500 });
      const [incoming, outgoing] = pair;
      const bindings: HttpBindings = { incoming, outgoing };
      return app.fetch(unreadableRequest(incoming), bindings);
    },
  });
  return (incoming, outgoing) => {
    // Host names ignore case, but the adapter refuses a `Host` in capitals.
    const host = incoming.headers.host;
    if (host) incoming.headers.host = host.toLowerCase();
    adaptLanCookies(incoming, outgoing);
    return raw.run([incoming, outgoing], () => viaHono(incoming, outgoing));
  };
}

/**
 * Build the Fetch request for one the adapter could not read: its path on
 * {@link UNREADABLE_ORIGIN} (`/` for a target that is not a path, such as
 * `OPTIONS *`), its method and headers, and a body read only if something
 * asks for it, so a route that reads the raw Node stream still gets every byte.
 */
function unreadableRequest(incoming: IncomingMessage): Request {
  const method = incoming.method ?? 'GET';
  const target = incoming.url?.startsWith('/') ? incoming.url : '/';
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || name === 'host') continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let chunks: AsyncIterator<Buffer> | undefined;
  const body = hasBody
    ? new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            chunks ??= incoming[Symbol.asyncIterator]();
            const next = await chunks.next();
            if (next.done) controller.close();
            else controller.enqueue(new Uint8Array(next.value));
          },
        },
        // Nothing is read until a reader asks: a high-water mark of 0.
        { highWaterMark: 0 }
      )
    : null;
  // Joined, never resolved: `//x` resolved against the origin would name host `x`.
  return new Request(`${UNREADABLE_ORIGIN}${target}`, {
    method,
    headers,
    body,
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** Options for {@link createFrontDoorServer}. */
export interface FrontDoorServerOptions {
  /**
   * Mark every request and upgrade this server takes as having come through
   * this listener (`services/core/remote/ingress-mark.ts`). The main listener
   * marks nothing; the Wi-Fi listener marks `wifi`.
   */
  ingress?: IngressKind;
}

/**
 * Create the Node HTTP server for the server's Hono app. It does not listen
 * yet; the caller decides the port and host, as `startMainListener` does.
 *
 * @param app - The app every request enters.
 * @param options - See {@link FrontDoorServerOptions}.
 * @returns A Node `http.Server` the upgrade router can attach to.
 */
export function createFrontDoorServer(
  app: Hono<ApiEnv>,
  options: FrontDoorServerOptions = {}
): Server {
  const { ingress } = options;
  const listener = frontDoorListener(app);
  const server = createServer(
    ingress
      ? (req, res) => {
          markIngress(req, ingress);
          return listener(req, res);
        }
      : listener
  );
  // First in line, so the upgrade router sees the mark and authorizes with the
  // cookie names the auth stack set (see `adaptLanCookies`).
  server.prependListener('upgrade', (req: IncomingMessage) => {
    if (ingress) markIngress(req, ingress);
    adaptLanCookies(req);
  });
  return server;
}
