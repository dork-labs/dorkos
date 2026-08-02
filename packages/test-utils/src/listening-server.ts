/**
 * One HTTP listener per test file, bound once and never rebound.
 *
 * Handed a non-listening Express app, supertest opens a fresh ephemeral
 * listener per REQUEST (`if (!addr) this._server = app.listen(0)`) and closes
 * it in the response callback. Node's `http.globalAgent` sets
 * `keepAlive: true`, so superagent pools sockets keyed by `host:port` — and an
 * ephemeral port freed by a closing listener is immediately reclaimable by the
 * next `listen(0)`. A pooled socket for `127.0.0.1:P` then gets handed to a
 * request meant for the NEW server on P.
 *
 * That surfaces two ways. `Error: Parse Error: Expected HTTP/, RTSP/ or ICE/`
 * (or `socket hang up`) when the peer is already gone — noisy, and it lands on
 * a random later test rather than the one that churned the port, so it reads as
 * unrelated noise. And, worse because it is silent, a request served by a
 * PREVIOUS test's app and its state, scoring the previous test's answer.
 *
 * `server.closeAllConnections()` narrows the window but does not close it: the
 * agent can hand out a pooled entry before the RST lands. Measured over 150
 * runs, a one-listener-per-test variant with `closeAllConnections()` still
 * flaked once. Binding ONE listener for the whole file removes the mechanism
 * instead of narrowing it — no port is ever freed mid-file, so no pooled socket
 * can be misrouted.
 *
 * The accepted cost: a listener-level failure now fails every test in the file
 * at once rather than one. That is the right trade — loud beats silent.
 *
 * @module listening-server
 */
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { beforeAll, afterAll } from 'vitest';

/**
 * Bind ONE listener for the calling scope and hand it to supertest instead of
 * the app: `request(server)` reuses the bound port, `request(app)` does not.
 *
 * Registers its own `beforeAll`/`afterAll`, so call it at module scope (or
 * inside the `describe` that owns it) and treat the returned server as a
 * constant:
 *
 * ```ts
 * const app = createApp();
 * finalizeApp(app);
 * const server = listeningServer(app);
 *
 * it('...', async () => {
 *   const res = await request(server).get('/api/health');
 * });
 * ```
 *
 * @param handler - The app (or bare request listener) to serve.
 * @returns The bound server. It is not listening until `beforeAll` runs.
 */
export function listeningServer(handler: RequestListener): Server {
  const server = createServer(handler);

  beforeAll(async () => {
    server.listen(0);
    await once(server, 'listening');
  });

  afterAll(async () => {
    // Keep-alive sockets outlive close() and would hold the worker open.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return server;
}

/** A single listener whose backing app is swapped per test. */
export interface SwappableServer {
  /** The one bound listener. Hand this to `request()`. */
  readonly server: Server;
  /**
   * Serve `app` from here on, and return the (unchanged) server so callers can
   * write `request(mount(app))` at the point of use.
   *
   * @param app - The app to serve for subsequent requests.
   * @returns The same server every time.
   */
  mount(app: RequestListener): Server;
}

/**
 * The per-test-isolation variant of {@link listeningServer}: still ONE listener,
 * but the app behind it is swapped rather than rebuilt-and-rebound. Use it when
 * tests need a fresh app (fresh in-memory store, fresh mocks, fresh config
 * directory) and would otherwise construct one per test in `beforeEach`.
 *
 * ```ts
 * const target = swappableServer();
 * const server = target.server;
 *
 * beforeEach(() => {
 *   target.mount(buildAppUnderTest());
 * });
 * ```
 *
 * Requests that arrive before anything is mounted get a 500 naming this helper,
 * so a missing `mount()` fails loudly instead of hanging or 404ing.
 *
 * @returns The bound server plus its `mount` setter.
 */
export function swappableServer(): SwappableServer {
  let current: RequestListener = (_req, res) => {
    res.statusCode = 500;
    res.end('swappableServer: no app mounted — call mount(app) before requesting');
  };

  const server = listeningServer((req, res) => current(req, res));

  return {
    server,
    mount(app: RequestListener): Server {
      current = app;
      return server;
    },
  };
}
