/**
 * A real HTTP server for the gateway's integration tests: Node's own `http`,
 * turning each request into a web `Request`, routing it to the gateway's
 * handlers the way `apps/server/src/routes/a2a.ts` mounts them, and writing
 * the `Response` back as it streams.
 *
 * The gateway reads its own body here (no `parsedBody`), the path a host that
 * does not pre-parse JSON takes.
 *
 * @module a2a-gateway/__tests__/serve-gateway
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { A2aGateway } from '../http-handlers.js';

/** Answers a request before the gateway does (an auth guard), or lets it on. */
export type Guard = (request: Request) => Response | undefined;

/** A listening server, with the gateway it routes to mounted after it listens. */
export interface ServedGateway {
  /** The Node server. */
  readonly server: Server;
  /** Where it listens, e.g. `http://127.0.0.1:53511`. */
  readonly baseUrl: string;
  /**
   * Route requests to `gateway`, behind `guard` when one is given. A card's
   * interface URL has to name the real port, so a test listens first and
   * builds the gateway after.
   */
  mount(gateway: A2aGateway, guard?: Guard): void;
  /** Stop listening. */
  close(): Promise<void>;
}

/** Route one request to the gateway, as the server's routes do. */
async function route(gateway: A2aGateway, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (request.method === 'GET' && path === '/.well-known/agent-card.json') {
    return gateway.fleetCard();
  }
  const card = /^\/a2a\/agents\/([^/]+)\/card$/.exec(path);
  if (request.method === 'GET' && card) return gateway.agentCard(decodeURIComponent(card[1]!));
  const agent = /^\/a2a\/agents\/([^/]+)$/.exec(path);
  if (request.method === 'POST' && agent) {
    return gateway.agentJsonRpc(decodeURIComponent(agent[1]!), request);
  }
  if (request.method === 'POST' && path === '/a2a') return gateway.jsonRpc(request);
  return new Response('Not found', { status: 404 });
}

/** The Node request as a web `Request`, its body read whole. */
async function toRequest(incoming: IncomingMessage, baseUrl: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
  }
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  return new Request(new URL(incoming.url ?? '/', baseUrl), {
    method: incoming.method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

/** Write a web `Response` to the Node response, a chunk at a time. */
async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  outgoing.once('close', () => {
    if (!outgoing.writableFinished) void reader.cancel();
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    outgoing.write(value);
  }
  outgoing.end();
}

/**
 * Start a server on a free loopback port.
 *
 * @returns The server, with nothing mounted yet.
 */
export async function serveGateway(): Promise<ServedGateway> {
  let mounted: { gateway: A2aGateway; guard?: Guard } | undefined;
  let baseUrl = '';
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const request = await toRequest(incoming, baseUrl);
      const response = !mounted
        ? new Response('Nothing mounted', { status: 503 })
        : (mounted.guard?.(request) ?? (await route(mounted.gateway, request)));
      await writeResponse(response, outgoing);
    })().catch((error: unknown) => {
      outgoing.statusCode = 500;
      outgoing.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    baseUrl,
    mount(gateway, guard) {
      mounted = { gateway, ...(guard ? { guard } : {}) };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
