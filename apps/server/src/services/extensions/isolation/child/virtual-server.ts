/**
 * The child half of an isolated extension's router (DOR-2686, spec §7): an
 * Express app with the extension's router mounted where DorkOS mounts it
 * (`/api/ext/<id>`), behind an `http.Server` that never listens.
 *
 * Connections arrive as `conn-open` messages from the host. Each becomes a
 * {@link VirtualSocket} handed to the server as if a client had connected, so
 * the extension sees an ordinary request: `req.baseUrl`, `req.path` and
 * `req.params` match the in-process case because the host forwards
 * `req.originalUrl` unchanged.
 *
 * The request it sees has no cookie, no authorization header and no DorkOS
 * tokens (the host strips them); `ctx.requirePerson` reads the host's verdict
 * instead (`proxy-ctx.ts`).
 *
 * A request the router does not answer goes to the extension's `fetch`
 * handler when `register()` returned one, as in-process
 * (`http/fetch-handler.ts`): the path below the mount, the caller's headers,
 * and a JSON body sent again as JSON or any other body as its stream.
 *
 * @module services/extensions/isolation/child/virtual-server
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type express from 'express';
import type { ExtensionFetchHandler } from '@dorkos/extension-api/server';
import type { ChildMessage, ConnMessage, HostMessage } from '../ipc-protocol.js';
import { VirtualSocket } from '../virtual-socket.js';

/** What {@link createVirtualServer} needs. */
export interface VirtualServerDeps {
  /** The extension id: the router is mounted at `/api/ext/<id>`. */
  extensionId: string;
  /** The bundled `express`. */
  express: typeof express;
  /** The router `register()` filled. */
  router: express.Router;
  /** Send one message to the host; `onWritten` runs once it is written to the channel. */
  send: (message: ChildMessage, onWritten?: () => void) => void;
}

/** The virtual server and its controls. */
export interface VirtualServer {
  /**
   * Handle a host message if it belongs to a virtual connection.
   *
   * @returns `true` when it did.
   */
  receive(message: HostMessage): boolean;
  /** Drop every open connection (the child is stopping). */
  closeAll(): void;
  /** Send what the router passes on to this `fetch` handler, or to the 404 for `null`. */
  serveFetch(handler: ExtensionFetchHandler | null): void;
}

/** Methods whose request carries no body. */
const BODILESS = new Set(['GET', 'HEAD']);

/**
 * Answer one request with an extension's `fetch` handler: a web `Request`
 * for the path below the mount (`req.url` inside the mount), and its
 * `Response` written back.
 *
 * @param handler - The extension's handler.
 * @param req - The request, with any JSON body already parsed.
 * @param res - Where the answer goes.
 */
async function answerWithFetch(
  handler: ExtensionFetchHandler,
  req: express.Request,
  res: express.Response
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  let body: BodyInit | null = null;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) {
      headers.delete(name);
    }
  } else if (!BODILESS.has(req.method)) {
    body = Readable.toWeb(req) as unknown as BodyInit;
  }
  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const answer: unknown = await handler(
    new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers,
      body,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit)
  );
  if (!(answer instanceof Response)) {
    throw new Error('The fetch handler answered with something that is not a Response.');
  }
  res.status(answer.status);
  // `set-cookie` is left out here: the host drops it from every reply anyway.
  answer.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  if (!answer.body) {
    res.end();
    return;
  }
  Readable.fromWeb(answer.body as WebReadableStream)
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * Build the virtual server for one extension's router.
 *
 * @param deps - See {@link VirtualServerDeps}.
 */
export function createVirtualServer(deps: VirtualServerDeps): VirtualServer {
  const app = deps.express();
  app.disable('x-powered-by');
  // DorkOS parses JSON bodies app-wide before any extension route (`app.ts`),
  // so in-process routes see `req.body` already; the same parser, with the
  // same limit, gives isolated routes the same request.
  app.use(deps.express.json({ limit: '1mb' }));
  app.use(`/api/ext/${deps.extensionId}`, deps.router);
  let fetchHandler: ExtensionFetchHandler | null = null;
  app.use(`/api/ext/${deps.extensionId}`, (req, res, next) => {
    if (!fetchHandler) {
      next();
      return;
    }
    answerWithFetch(fetchHandler, req, res).catch(next);
  });
  // Nothing in the router matched.
  app.use((req: express.Request, res: express.Response) => {
    res.status(404).json({ error: `Extension '${deps.extensionId}' has no route for ${req.path}` });
  });
  // A route threw: answer like DorkOS's own handler, without a stack.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('Route error:', err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  );

  const server = http.createServer(app);
  // A request that ends its stream early or never sends headers is the
  // host's problem to time out; nothing here waits on a wall clock.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  const sockets = new Map<number, VirtualSocket>();

  const send = (message: ConnMessage, onWritten?: () => void): boolean => {
    try {
      deps.send(message, onWritten);
      return true;
    } catch {
      return false;
    }
  };

  return {
    receive(message) {
      switch (message.type) {
        case 'conn-open': {
          if (sockets.has(message.cid)) return true;
          const socket = new VirtualSocket({
            cid: message.cid,
            send,
            onClose: () => sockets.delete(message.cid),
          });
          sockets.set(message.cid, socket);
          server.emit('connection', socket);
          return true;
        }
        case 'conn-data':
        case 'conn-end':
        case 'conn-destroy':
        case 'conn-pause':
        case 'conn-resume':
          sockets.get(message.cid)?.receive(message);
          return true;
        default:
          return false;
      }
    },
    closeAll() {
      for (const socket of sockets.values()) socket.destroy();
      sockets.clear();
    },
    serveFetch(handler) {
      fetchHandler = handler;
    },
  };
}
