import { createConnection, createServer, type Socket } from 'node:net';
import { createServer as createHTTPServer, IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createNodeBrokerTransport } from '../node/node-transport.js';
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
async function waitFor(predicate: () => boolean) {
  const end = performance.now() + 1000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error('fixture observation expired');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
it('registers its original listener before listen and retains accepted originals through real close', async () => {
  const f = await listener();
  const client = await connect(f.ready.port);
  client.write(
    'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Bearer credential\r\n\r\n'
  );
  await waitFor(() => f.requests.length === 1);
  expect(f.admitted[0].identity).toBe(f.requests[0].client.identity);
  expect(f.admitted[0].observedClosed).toBe(false);
  expect(frameRequest(f.requests[0].raw, BROKER_LIMITS).url).toBe('http://example.test/');
  let observed = false;
  f.ready.onClose(() => {
    observed = true;
  });
  f.ready.close();
  expect(observed).toBe(false); // destroy/close attempts do not invent synchronous receipts.
  await f.closed;
  expect(f.admitted[0].observedClosed).toBe(true);
});
it.each(['missing-quota', 'callback-throws', 'overflow'] as const)(
  'closes the aggregate pre-owned intake rather than dropping an untracked original (%s)',
  async (mode) => {
    const f = await listener(
      mode === 'missing-quota'
        ? { reserveSocket: () => undefined }
        : mode === 'callback-throws'
          ? {
              onSocket: () => {
                throw new Error('fallible caller');
              },
            }
          : { maxConnections: 1 }
    );
    const port = f.ready.port;
    const first = await connect(port);
    if (mode === 'overflow') await connect(port);
    await f.closed;
    first.resume();
    await waitFor(() => first.destroyed);
    expect(first.destroyed).toBe(true);
    await expect(
      new Promise<void>((resolve, reject) => {
        const late = createConnection({ host: '127.0.0.1', port });
        late.once('connect', () => {
          late.destroy();
          resolve();
        });
        late.once('error', reject);
      })
    ).rejects.toThrow();
  }
);
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
it.each(['CONNECT', 'websocket'] as const)(
  'preserves actual %s parser head without forwarding it before broker admission',
  async (kind) => {
    const f = await listener();
    const client = await connect(f.ready.port);
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    client.write(
      kind === 'CONNECT'
        ? 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: Bearer credential\r\n\r\nearly-head'
        : `GET ws://example.test/fixture HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Bearer credential\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\nearly-head`
    );
    await waitFor(() => f.requests.length === 1);
    expect(Buffer.from(f.requests[0].raw.head).toString()).toBe('early-head');
    expect(frameRequest(f.requests[0].raw, BROKER_LIMITS).kind).toBe(
      kind === 'CONNECT' ? 'opaque-connect' : 'websocket'
    );
  }
);
it('keeps the exact numeric origin socket for an actual WebSocket upgrade and raw duplex bytes', async () => {
  const server = createHTTPServer();
  const originSockets: Socket[] = [];
  server.on('upgrade', (_request, socket) => {
    originSockets.push(socket as Socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\norigin-head'
    );
    socket.on('data', (bytes) => socket.write(bytes));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of originSockets) socket.destroy();
        server.close(() => resolve());
      })
  );
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
  const framed = frameRequest(
    {
      method: 'GET',
      target: 'ws://example.test/fixture',
      head: new Uint8Array(),
      rawHeaders: [
        'Host',
        'example.test',
        'Proxy-Authorization',
        'Bearer credential',
        'Connection',
        'Upgrade',
        'Upgrade',
        'websocket',
        'Sec-WebSocket-Version',
        '13',
        'Sec-WebSocket-Key',
        'dGhlIHNhbXBsZSBub25jZQ==',
      ],
    },
    BROKER_LIMITS
  );
  const response = await transport.exchange(
    dial.socket,
    framed,
    { onData: () => () => {}, onEnd: () => () => {}, pause() {}, resume() {} },
    { check: () => {}, bodyLimit: 1024, queueLimit: 131072 }
  );
  expect(response.status).toBe(101);
  expect(Buffer.from(response.head).toString()).toBe('origin-head');
  expect(dial.socket.observedClosed).toBe(false);
  const echoed = new Promise<string>((resolve) =>
    dial.socket.onData((bytes) => resolve(Buffer.from(bytes).toString()))
  );
  dial.socket.resume();
  dial.socket.write(Buffer.from('actual duplex'));
  expect(await echoed).toBe('actual duplex');
  const closed = new Promise<void>((resolve) => dial.socket.onClose(resolve));
  dial.socket.destroy();
  await closed;
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
it('retains aggregate listener custody when original socket close is deliberately delayed', async () => {
  let acknowledge!: () => void;
  const f = await listener({
    onSocket: (_slot, socket) => {
      const original = socket.identity as Socket;
      const actualDestroy = original.destroy.bind(original);
      acknowledge = () => {
        actualDestroy();
      };
      original.destroy = () => original;
      return true;
    },
  });
  const client = await connect(f.ready.port);
  await waitFor(() => !!acknowledge);
  let observed = false;
  f.ready.onClose(() => {
    observed = true;
  });
  f.ready.close();
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(observed).toBe(false);
  acknowledge();
  client.resume();
  await f.closed;
  expect(observed).toBe(true);
});

it.each(['CONNECT', 'websocket'] as const)(
  'returns the actual %s header-message custody after its original upgraded socket closes',
  async (kind) => {
    const records: { bank: Set<unknown>; message: IncomingMessage }[] = [];
    const add = Set.prototype.add;
    const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (value instanceof IncomingMessage) records.push({ bank: this, message: value });
      return add.call(this, value);
    });
    try {
      const f = await listener();
      const client = await connect(f.ready.port);
      client.write(
        kind === 'CONNECT'
          ? 'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: Bearer credential\r\n\r\n'
          : 'GET ws://example.test/ HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Bearer credential\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      );
      await waitFor(() => f.requests.length === 1);
      expect(records).toHaveLength(1);
      expect(records[0].bank.has(records[0].message)).toBe(true);
      const clientClosed = originalClose(client);
      client.resume();
      f.ready.close();
      await f.closed;
      await clientClosed;
      expect(records[0].message.socket.destroyed).toBe(true);
      expect(records[0].bank.has(records[0].message)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }
);

it('contains a late close-observer failure after the real original receipt', async () => {
  const f = await listener();
  const client = await connect(f.ready.port);
  client.write(
    'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Bearer credential\r\n\r\n'
  );
  await waitFor(() => f.requests.length === 1);
  f.ready.close();
  client.resume();
  await f.closed;
  const lateSocket = vi.fn(() => {
    throw new Error('late original socket observer');
  });
  const lateListener = vi.fn(() => {
    throw new Error('late original intake observer');
  });
  f.admitted[0].onClose(lateSocket);
  f.ready.onClose(lateListener);
  await new Promise((resolve) => setImmediate(resolve));
  expect(lateSocket).toHaveBeenCalledOnce();
  expect(lateListener).toHaveBeenCalledOnce();
});
