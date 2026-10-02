import { createServer, request as httpRequest } from 'node:http';
import { BrowserManagerError } from './manager-error.mjs';

/** Validate the exact local fixture origin used by this bounded experiment. */
export function fixtureOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserManagerError('INVALID_FIXTURE_ORIGIN');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new BrowserManagerError('INVALID_FIXTURE_ORIGIN');
  return url.origin;
}

/**
 * A bounded exact-origin HTTP proxy fences service-worker traffic too. Playwright
 * routing would disable HTTP cache and cannot alone fence worker-owned requests.
 * This proxy never opens an outgoing socket before comparing the exact origin.
 */
export async function startFixtureProxy(origin) {
  const pending = new Set();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (incoming, response) => {
    let target;
    try {
      target = new URL(incoming.url);
    } catch {
      response.writeHead(403);
      response.end();
      return;
    }
    if (target.origin !== origin || target.username || target.password) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (pending.size >= 32) {
      response.writeHead(503);
      response.end();
      return;
    }
    const headers = { ...incoming.headers, host: target.host };
    for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'upgrade'])
      delete headers[key];
    const outgoing = httpRequest(
      target,
      { method: incoming.method, headers, agent: false },
      (upstream) => {
        response.writeHead(upstream.statusCode, upstream.headers);
        let bytes = 0;
        upstream.on('data', (chunk) => {
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
    let bodyBytes = 0;
    incoming.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > 1024 * 1024) {
        outgoing.destroy();
        incoming.destroy();
      }
    });
    incoming.pipe(outgoing);
  });
  server.on('connect', (_, socket) => socket.destroy());
  server.on('upgrade', (_, socket) => socket.destroy());
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        for (const request of pending) request.destroy();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
