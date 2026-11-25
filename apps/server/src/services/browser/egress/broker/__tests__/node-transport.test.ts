import { createConnection, createServer, type Socket } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createNodeBrokerTransport } from '../node-transport.js';
import { frameRequest } from '../framing.js';
import { BROKER_LIMITS } from '../limits.js';
import type { AcceptedRequest, OwnedListener, OwnedSocket, RequestBody } from '../transport.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function originalClose(socket: Socket) {
  return socket.destroyed ? Promise.resolve() : once(socket, 'close');
}
async function listener(
  overrides: Partial<Parameters<ReturnType<typeof createNodeBrokerTransport>['listen']>[0]> = {}
) {
  const transport = createNodeBrokerTransport();
  const admitted: OwnedSocket[] = [],
    requests: AcceptedRequest[] = [];
  let original!: OwnedListener;
  const callback = vi.fn((value: OwnedListener) => {
    original = value;
    expect(value.port).toBe(0);
    return true;
  });
  const ready = await transport.listen({
    maxConnections: 2,
    headerBytes: 16384,
    headerMs: 1000,
    reserveSocket: () => ({ kind: 'socket-admission' }),
    onSocket: (_slot, socket) => {
      admitted.push(socket);
      return true;
    },
    onListener: callback,
    onRequest: (request) => requests.push(request),
    onPipeline: (socket) => socket.destroy(),
    ...overrides,
  });
  expect(ready).toBe(original);
  const closed = new Promise<void>((resolve) => ready.onClose(resolve));
  cleanups.push(async () => {
    ready.close();
    await closed;
  });
  return { ready, admitted, requests, transport, closed };
}
async function connect(port: number) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const terminal = once(socket, 'close');
  socket.on('error', () => {});
  cleanups.push(async () => {
    socket.destroy();
    await terminal;
  });
  await once(socket, 'connect');
  return socket;
}
it('refuses strict parser ambiguity without dispatching a request', async () => {
  const f = await listener();
  const client = await connect(f.ready.port);
  const closed = originalClose(client);
  client.write(
    'POST http://example.test/ HTTP/1.1\r\nHost: example.test\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx'
  );
  await closed;
  expect(f.requests).toHaveLength(0);
  expect(f.admitted[0].observedClosed).toBe(true);
});
it('binds a numeric dial original before connect, never resolves a hostname, and observes actual failed-connect close', async () => {
  const transport = createNodeBrokerTransport();
  const server = createServer((socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const lookup = vi.fn((): never => {
    throw new Error('no DNS');
  });
  let original!: OwnedSocket;
  const dial = await transport.dial(
    { address: '127.0.0.1', family: 4, port: address.port },
    {
      signal: new AbortController().signal,
      autoSelectFamily: false,
      lookup,
      onSocket: (socket) => {
        original = socket;
        expect(socket.peer).toBeUndefined();
        return true;
      },
    }
  );
  expect(dial.outcome).toBe('connected');
  expect(dial.socket).toBe(original);
  expect(dial.socket.peer).toEqual({ address: '127.0.0.1', family: 4, port: address.port });
  const returned = new Promise<void>((resolve) => original.onClose(resolve));
  original.resume();
  await returned;
  expect(original.observedClosed).toBe(true);
  expect(lookup).not.toHaveBeenCalled();
  await expect(
    transport.dial(
      { address: 'example.test', family: 4, port: 80 },
      {
        signal: new AbortController().signal,
        autoSelectFamily: false,
        lookup,
        onSocket: () => true,
      }
    )
  ).rejects.toThrow('PEER_REFUSED');
});
it('exchanges HTTP through the exact dialed numeric original and genuine decoded body EOF', async () => {
  const server = createHTTPServer((request, response) => {
    expect(request.url).toBe('/fixture');
    expect(request.headers['proxy-authorization']).toBeUndefined();
    request.resume();
    request.on('end', () => {
      response.write('actual ');
      response.end('origin');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const transport = createNodeBrokerTransport();
  const dial = await transport.dial(
    { address: '127.0.0.1', family: 4, port: address.port },
    {
      signal: new AbortController().signal,
      autoSelectFamily: false,
      lookup: () => {
        throw new Error('DNS');
      },
      onSocket: () => true,
    }
  );
  const request = frameRequest(
    {
      method: 'GET',
      target: 'http://example.test/fixture',
      head: new Uint8Array(),
      rawHeaders: ['Host', 'example.test', 'Proxy-Authorization', 'Bearer credential'],
    },
    BROKER_LIMITS
  );
  const stream = Readable.from([]);
  const input: RequestBody = {
    onData(cb) {
      stream.on('data', cb);
      return () => {
        stream.off('data', cb);
      };
    },
    onEnd(cb) {
      stream.on('end', cb);
      return () => {
        stream.off('end', cb);
      };
    },
    pause() {
      stream.pause();
    },
    resume() {
      stream.resume();
    },
  };
  const response = await transport.exchange(dial.socket, request, input, {
    check: () => {},
    bodyLimit: 1024,
    queueLimit: 131072,
  });
  const chunks: Uint8Array[] = [];
  const done = new Promise<void>((resolve) => response.body.onEnd(resolve));
  response.body.onData((chunk) => chunks.push(chunk));
  response.body.resume();
  await done;
  expect(response.status).toBe(200);
  expect(Buffer.concat(chunks).toString()).toBe('actual origin');
});
it('refuses pipelined requests on the same original rather than acquiring a second circuit', async () => {
  let pipeline = 0;
  const f = await listener({
    onPipeline: (socket) => {
      pipeline++;
      socket.destroy();
    },
  });
  const client = await connect(f.ready.port),
    closed = originalClose(client);
  const first =
    'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Bearer credential\r\n\r\n';
  client.write(first + first);
  client.resume();
  await closed;
  expect(f.requests).toHaveLength(1);
  expect(pipeline).toBe(1);
  expect(f.admitted).toHaveLength(1);
});
