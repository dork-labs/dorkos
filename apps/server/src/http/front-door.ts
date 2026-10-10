/**
 * The server's front door: one Hono app every HTTP request enters through.
 *
 * This is the first step of the move from Express to Hono (ADR `261009-192542`,
 * `plans/2026-10-express-to-hono.md`). Today the front door owns no routes of
 * its own. Its single catch-all hands the raw Node request and response to the
 * existing Express app, so Express runs exactly as it did when it was the
 * listener itself: same middleware chain, same body parsing, same bytes on the
 * wire. Route groups move one at a time onto the Hono `/api` app
 * (`http/api-chain.ts`); the front door sends a request there only when one of
 * that app's routes matches its method and path, and the last step deletes the
 * catch-all. A request therefore runs exactly one middleware chain.
 *
 * Four choices keep "exactly as before" true. `__tests__/front-door.test.ts`
 * pins each one that a request can observe:
 *
 * - **A request Hono cannot read still reaches Express.** The Node adapter
 *   builds a URL from `Host` and answers a bare 400 when it cannot: no `Host`
 *   (HTTP/1.0), a port out of range, `OPTIONS *`. Express decides those today,
 *   through `hostGuard` with its logged 403 or by serving them, so
 *   {@link createFrontDoorServer} gives them to Express untouched. A `Host` in
 *   capitals it would also refuse is lower-cased first, so a moved route
 *   answers it as Express did.
 * - **`overrideGlobalObjects: false`.** By default the adapter swaps the
 *   process-wide `Request` and `Response` for its own lightweight classes.
 *   Better Auth, the MCP SDK and every `fetch` caller in the server build those
 *   objects too, and must keep getting the platform's own.
 * - **`autoCleanupIncoming: false`.** By default the adapter reads and throws
 *   away a body the handler never read, and cuts the connection after 500 ms.
 *   Node already discards an unread body itself and keeps the connection, which
 *   is what a route that refuses before reading an upload relies on today.
 * - **The catch-all settles only once the Node response has closed**, so to
 *   Hono a handed-off request lasts as long as its response does. Nothing reads
 *   that lifetime yet; anything later wrapped around the catch-all (timing,
 *   admission) needs it to be the real one.
 *
 * WebSocket upgrades never pass through here: Node emits `upgrade` on the
 * server, not as a request, and `attachUpgradeRouter` claims it there.
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
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import { expressCensus, honoCensus } from './route-census/census.js';
import type { ApiEnv } from './api-chain.js';

/** The Hono environment of the front door: the raw Node request and response. */
export type FrontDoorEnv = { Bindings: HttpBindings };

/** A Hono app built by {@link createFrontDoor}, still holding its fallback. */
export interface FrontDoor {
  /** The Hono app every request enters. */
  readonly app: Hono<FrontDoorEnv>;
  /** Where a request goes when no Hono route claims it, or Hono cannot read it. */
  readonly legacy: RequestListener;
}

/** Options for {@link createFrontDoor}. */
export interface FrontDoorOptions {
  /**
   * The Hono `/api` app the moved route groups are mounted on
   * (`http/hono-api.ts`). Each of its routes is claimed here, ahead of the
   * catch-all; its chain middleware is not a route and claims nothing.
   */
  api?: Hono<ApiEnv>;
  /**
   * Serve the route census at `GET /api/test/route-census`
   * (`route-census/census.ts`). Only a test server turns this on.
   */
  census?: boolean;
}

/**
 * Build the front door, with every request handed to `legacy`.
 *
 * @param legacy - The Express app, or any Node request listener, that answers
 *   every request no Hono route has claimed.
 * @param options - See {@link FrontDoorOptions}.
 * @returns The front door. Serve it with {@link createFrontDoorServer}.
 */
export function createFrontDoor(
  legacy: RequestListener,
  options: FrontDoorOptions = {}
): FrontDoor {
  // Not strict, like the `/api` app and Express: `/api/x/` is `/api/x`.
  const app = new Hono<FrontDoorEnv>({ strict: false });
  if (options.census) {
    app.get('/api/test/route-census', (c) => {
      const express = 'router' in legacy ? expressCensus(legacy as never) : undefined;
      if (!express) {
        return c.json({ error: 'Start the server with route-census/record-mount-paths.ts' }, 409);
      }
      return c.json({ hono: honoCensus(app), express });
    });
  }
  if (options.api) claimApiRoutes(app, options.api);
  app.all('*', (c) => handOff(legacy, c.env.incoming, c.env.outgoing));
  return { app, legacy };
}

/**
 * Claim every route of the `/api` app on the front door, each handing its
 * request to that app whole, so it runs the Hono chain and nothing else.
 *
 * Chain-wide middleware is registered on `*` and serves no request by itself,
 * so it is skipped: a path no moved route matches still reaches Express.
 * ANYTHING registered on a path claims it, middleware included, because Hono
 * records `use(path)` and `all(path)` alike. That is the rule a move follows:
 * a group moves whole, so its middleware's path is its routes' path. A stray
 * claim on a path Express still serves fails the route census
 * (`route-census.test.ts`) and its shadowing check.
 */
function claimApiRoutes(door: Hono<FrontDoorEnv>, api: Hono<ApiEnv>): void {
  const claimed = new Set<string>();
  for (const { method, path } of api.routes) {
    const key = `${method} ${path}`;
    if (path === '/*' || claimed.has(key)) continue;
    claimed.add(key);
    door.on(method, path, (c) => api.fetch(c.req.raw, c.env));
  }
}

/**
 * The Node request listener for a front door: Hono for every request it can
 * read, the legacy listener directly for the rest.
 *
 * @param door - The front door from {@link createFrontDoor}.
 * @returns A Node request listener.
 */
export function frontDoorListener(door: FrontDoor): RequestListener {
  // The adapter reports an unreadable request to `errorHandler` with only the
  // error, synchronously inside the listener call. This carries the raw pair
  // to it, so the adapter's own judgement decides and none of it is copied.
  const raw = new AsyncLocalStorage<[IncomingMessage, ServerResponse]>();
  const viaHono = getRequestListener(door.app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: false,
    errorHandler: (error) => {
      const pair = raw.getStore();
      if (error instanceof RequestError && pair) {
        door.legacy(...pair);
        return; // Nothing for the adapter to write: Express answers.
      }
      return new Response(null, { status: 500 });
    },
  });
  return (incoming, outgoing) => {
    // Host names ignore case, but the adapter refuses a `Host` in capitals, and
    // such a request could then reach only Express, never a moved route.
    const host = incoming.headers.host;
    if (host) incoming.headers.host = host.toLowerCase();
    return raw.run([incoming, outgoing], () => viaHono(incoming, outgoing));
  };
}

/**
 * Create the Node HTTP server for a front door. It does not listen yet; the
 * caller decides the port and host, as `startMainListener` does.
 *
 * @param door - The front door from {@link createFrontDoor}.
 * @returns A Node `http.Server` the upgrade router can attach to.
 */
export function createFrontDoorServer(door: FrontDoor): Server {
  return createServer(frontDoorListener(door));
}

/**
 * Give one request to a Node request listener and wait until its response has
 * closed, then tell the adapter not to write anything itself.
 */
function handOff(
  legacy: RequestListener,
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<Response> {
  return new Promise((resolve) => {
    // A fresh marker each time: the shared `RESPONSE_ALREADY_SENT` has mutable
    // headers, and a later middleware that sets one after `next()` would write
    // it into every request after.
    outgoing.once('close', () =>
      resolve(new Response(null, { headers: RESPONSE_ALREADY_SENT.headers }))
    );
    legacy(incoming, outgoing);
  });
}
