import { createServer, Server } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import request, { type Response, type Test } from '@dorkos/test-utils/supertest';

const servers: Server[] = [];

async function listeningTestServer(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  });
  servers.push(server);
  server.listen(0);
  await once(server, 'listening');
  return server;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

describe('stable-target Supertest facade', () => {
  it('retains the chainable request surface and installed response types', async () => {
    expectTypeOf(request).parameters.toEqualTypeOf<[Server | string]>();
    expect(request).not.toHaveProperty('agent');

    const server = await listeningTestServer();
    let observedRequests = 0;
    const observeRequest = () => {
      observedRequests += 1;
    };
    server.on('request', observeRequest);
    const builder = request(server);
    const pending: Test = builder.get('/probe').set('X-Probe', 'yes');
    let response: Response;
    try {
      response = await pending;
    } finally {
      server.off('request', observeRequest);
    }

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ path: '/probe' });
    expect(observedRequests).toBe(1);
    expect(typeof builder.get).toBe('function');
    expect(typeof builder.post).toBe('function');
    expect(typeof builder.patch).toBe('function');
  });

  it('dispatches an explicit HTTP URL through the named loopback listener', async () => {
    const server = await listeningTestServer();
    let observedRequests = 0;
    server.on('request', () => {
      observedRequests += 1;
    });
    const { port } = server.address() as AddressInfo;

    const response = await request(`http://127.0.0.1:${port}`).get('/via-url');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ path: '/via-url' });
    expect(observedRequests).toBe(1);
  });

  it('accepts an HTTPS URL without dispatching an external request', () => {
    const builder = request('https://example.test');

    expect(typeof builder.get).toBe('function');
    expect(typeof builder.post).toBe('function');
  });

  it.each(['', '/api/health', 'localhost:4242', 'ftp://example.test', 'http://'])(
    'rejects a malformed or unsupported URL: %s',
    (url) => {
      expect(() => request(url)).toThrow(/http:\/\/ or https:\/\//i);
    }
  );

  it('rejects a callable app before Supertest can create and bind a server', async () => {
    const app: RequestListener = (_req, res) => res.end('implicit-listener');
    const listen = vi.spyOn(Server.prototype, 'listen');
    let thrown: unknown;

    try {
      request(app as unknown as Server).get('/probe');
    } catch (error) {
      thrown = error;
    }

    try {
      expect.soft(thrown).toBeInstanceOf(TypeError);
      expect
        .soft(String(thrown))
        .toMatch(/callable Express app.*listeningServer\(\).*swappableServer\(\)/);
      expect.soft(listen).not.toHaveBeenCalled();
    } finally {
      await Promise.all(
        listen.mock.contexts
          .filter((server): server is Server => server instanceof Server && server.listening)
          .map(
            (server) =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              })
          )
      );
      listen.mockRestore();
    }
  });

  it('rejects an unbound server before Supertest can bind it', async () => {
    const server = createServer();
    const listen = vi.spyOn(server, 'listen');
    let thrown: unknown;

    try {
      request(server).get('/probe');
    } catch (error) {
      thrown = error;
    }

    try {
      expect.soft(thrown).toBeInstanceOf(TypeError);
      expect
        .soft(String(thrown))
        .toMatch(/already-listening.*listeningServer\(\).*swappableServer\(\)/);
      expect.soft(listen).not.toHaveBeenCalled();
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      listen.mockRestore();
    }
  });
});
