import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type OutgoingHttpHeaders,
} from 'node:http';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

/** Owned fixture-only network fence; it is not the production destination broker. */
export interface FixtureProxy {
  readonly url: string;
  close(): Promise<void>;
}

/** Fence worker/cache traffic without routing interception or any generic forwarding. */
export async function startFixtureProxy(origin: string): Promise<FixtureProxy> {
  if (new URL(origin).protocol !== 'http:')
    throw new BrowserLifecycleError('NETWORK_POLICY_UNSUPPORTED');
  const pending = new Set<ClientRequest>();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (incoming, response) => {
    let target: URL;
    try {
      target = new URL(incoming.url ?? '');
    } catch {
      response.writeHead(403).end();
      return;
    }
    if (target.origin !== origin || target.username || target.password) {
      response.writeHead(403).end();
      return;
    }
    if (pending.size >= 32) {
      response.writeHead(503).end();
      return;
    }
    const headers: OutgoingHttpHeaders = { ...incoming.headers, host: target.host };
    for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade'])
      delete headers[key];
    const outgoing = httpRequest(
      target,
      { method: incoming.method, headers, agent: false },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        let bytes = 0;
        upstream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            outgoing.destroy();
            response.destroy();
          }
        });
        upstream.pipe(response);
      }
    );
    pending.add(outgoing);
    const timer = setTimeout(() => {
      outgoing.destroy();
      response.destroy();
    }, 3000);
    outgoing.on('close', () => {
      clearTimeout(timer);
      pending.delete(outgoing);
    });
    outgoing.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    incoming.on('aborted', () => outgoing.destroy());
    response.on('close', () => outgoing.destroy());
    let bytes = 0;
    incoming.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        outgoing.destroy();
        incoming.destroy();
      }
    });
    incoming.pipe(outgoing);
  });
  server.on('connect', (_, socket) => socket.destroy());
  server.on('upgrade', (_, socket) => socket.destroy());
  server.requestTimeout = server.headersTimeout = 3000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch {
    server.close();
    throw new BrowserLifecycleError('FIXTURE_PROXY_UNAVAILABLE');
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new BrowserLifecycleError('FIXTURE_PROXY_UNAVAILABLE');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const request of pending) request.destroy();
        server.closeAllConnections();
        server.close((error) =>
          error ? reject(new BrowserLifecycleError('FIXTURE_PROXY_CLOSE_FAILED')) : resolve()
        );
      }),
  };
}
