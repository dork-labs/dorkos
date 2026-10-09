/**
 * The server's front door: one Hono app every HTTP request enters through.
 *
 * This is the first step of the move from Express to Hono (ADR `261009-192542`,
 * `plans/2026-10-express-to-hono.md`). Today the front door owns no routes of
 * its own. Its single catch-all hands the raw Node request and response to the
 * existing Express app, so Express runs exactly as it did when it was the
 * listener itself: same middleware chain, same body parsing, same bytes on the
 * wire. Later steps move one route group at a time in front of the catch-all,
 * and the last one deletes it.
 *
 * Two choices keep "exactly as before" true:
 *
 * - `overrideGlobalObjects: false`. By default the Node adapter swaps the
 *   process-wide `Request` and `Response` for its own lightweight classes.
 *   Better Auth, the MCP SDK and every `fetch` caller in the server build those
 *   objects too, and must keep getting the platform's own. Pinned by
 *   `__tests__/front-door.test.ts`.
 * - The catch-all resolves only once the Node response has CLOSED, so to Hono
 *   a request lasts exactly as long as Express is working on it. Nothing reads
 *   that lifetime yet; anything later wrapped around the catch-all (timing,
 *   admission) needs it to be the real one. The adapter's clean-up of a body
 *   Express never read waits for the response to finish either way.
 *
 * WebSocket upgrades never pass through here: Node emits `upgrade` on the
 * server, not as a request, and `attachUpgradeRouter` claims it there.
 *
 * @module http/front-door
 */
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';
import { createAdaptorServer, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';

/** The Hono environment of the front door: the raw Node request and response. */
export type FrontDoorEnv = { Bindings: HttpBindings };

/**
 * Build the front-door Hono app, with every request handed to `legacy`.
 *
 * @param legacy - The Express app, or any Node request listener, that answers
 *   every request no Hono route has claimed.
 * @returns The Hono app. Serve it with {@link createFrontDoorServer}.
 */
export function createFrontDoor(legacy: RequestListener): Hono<FrontDoorEnv> {
  const app = new Hono<FrontDoorEnv>();
  app.all('*', (c) => handOff(legacy, c.env.incoming, c.env.outgoing));
  return app;
}

/**
 * Create the Node HTTP server for a front-door app. It does not listen yet;
 * the caller decides the port and host, as `startMainListener` does.
 *
 * @param app - The front-door app from {@link createFrontDoor}.
 * @returns A Node `http.Server` the upgrade router can attach to.
 */
export function createFrontDoorServer(app: Hono<FrontDoorEnv>): Server {
  return createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server;
}

/**
 * Give one request to a Node request listener and wait until its response is
 * finished with, then tell the adapter not to write anything itself.
 */
function handOff(
  legacy: RequestListener,
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<Response> {
  return new Promise((resolve) => {
    outgoing.once('close', () => resolve(RESPONSE_ALREADY_SENT));
    legacy(incoming, outgoing);
  });
}
