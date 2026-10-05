import { createHash } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { fixture, turns } from './broker-fixture.js';
import { FakeBody, FakeSocket } from './fake-transport.js';
import { readWebSocketConnectHandshake } from '../websocket-connect.js';
import { frameRequest } from '../framing.js';
import { BROKER_LIMITS } from '../limits.js';
import { ownNodeSocket } from '../node-transport-socket.js';

const key = 'dGhlIHNhbXBsZSBub25jZQ==';
const handshake = (authority = '127.0.0.1:43124', extra = '') =>
  `GET /socket HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

it('distinct grant waits for fragmented strict handshake before numeric dial and preserves upstream head', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.broker.grantLocal('ws://127.0.0.1:43124/', 'websocket-connect', 30000);
  vi.mocked(f.fake.transport.exchange).mockResolvedValue({
    status: 101,
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-accept': createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64'),
    },
    websocketAccept: createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64'),
    body: new FakeBody(),
    head: Buffer.from('original-frame'),
  });
  f.fake.accept(client, f.request('CONNECT', '127.0.0.1:43124'));
  await turns();
  expect(client.writes).toEqual(['HTTP/1.1 200 Connection Established\r\n\r\n']);
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  const bytes = handshake();
  client.emit(bytes.slice(0, 17));
  await turns();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  client.emit(bytes.slice(17));
  await turns();
  expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.fake.origins[0]!.peer).toMatchObject({ address: '127.0.0.1', port: 43124 });
  expect(f.fake.origins[0]!.writes).toEqual([]); // Inner HTTP is not replayed after 101.
  expect(client.writes.join('')).toContain('101 Origin');
  expect(client.writes.join('')).toContain('original-frame');
  client.emit('original-client-frame');
  expect(f.fake.origins[0]!.writes).toEqual(['original-client-frame']);
});

it('ordinary websocket consent does not authorize CONNECT', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.broker.grantLocal('ws://127.0.0.1:43124/', 'websocket', 30000);
  f.fake.accept(client, f.request('CONNECT', '127.0.0.1:43124'));
  await turns();
  expect(client.writes).toEqual([]);
  expect(client.observedClosed).toBe(true);
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
});

it('revocation after 200 but before inner handshake refuses any origin dial', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.broker.grantLocal('ws://127.0.0.1:43124/', 'websocket-connect', 30000);
  f.fake.accept(client, f.request('CONNECT', '127.0.0.1:43124'));
  await turns();
  expect(client.writes.join('')).toContain('200 Connection Established');
  f.issuer.revoke(f.run);
  client.emit(handshake());
  await turns();
  expect(client.observedClosed).toBe(true);
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
});

const denied = [
  ['TLS', '\x16\x03\x01\x00\x20'],
  ['arbitrary payload', 'anything\r\n\r\n'],
  ['authority mismatch', handshake('127.0.0.1:43125')],
  [
    'nested absolute request',
    handshake().replace('GET /socket', 'GET http://127.0.0.1:43124/socket'),
  ],
  ['proxy authorization', handshake(undefined, 'Proxy-Authorization: Bearer forbidden\r\n')],
  ['origin authorization', handshake(undefined, 'Authorization: forbidden\r\n')],
  ['empty body declaration', handshake(undefined, 'Content-Length: 0\r\n')],
  ['transfer encoding', handshake(undefined, 'Transfer-Encoding: chunked\r\n')],
  ['early frame', handshake() + '\x81\x00'],
  ['pipelined request', handshake() + handshake()],
  ['byte capacity', 'G'.repeat(BROKER_LIMITS.headerBytes + 1)],
] as const;

// These controls use actual original accepted Node sockets, not parser-only DTOs.
it.each(denied)(
  'actual client socket rejects %s before origin acquisition',
  async (_name, bytes) => {
    const sockets = new Set<Socket>();
    const server = createServer();
    let classified: Promise<unknown> | undefined;
    let accepted!: () => void;
    const acquisition = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const outer = frameRequest(
      {
        method: 'CONNECT',
        target: '127.0.0.1:43124',
        rawHeaders: ['Host', '127.0.0.1:43124', 'Proxy-Authorization', 'Bearer ' + 'A'.repeat(43)],
        head: new Uint8Array(),
      },
      BROKER_LIMITS
    );
    server.on('connection', (original) => {
      sockets.add(original);
      original.once('close', () => sockets.delete(original));
      classified = readWebSocketConnectHandshake({
        client: ownNodeSocket(original),
        head: new Uint8Array(),
        outer,
        limits: BROKER_LIMITS,
        check: () => {},
      });
      // Install rejection handling before the client can deliver bytes.
      void classified.catch(() => original.destroy());
      accepted();
    });
    onTestFinished(async () => {
      const closures = [...sockets].map((socket) =>
        socket.closed ? Promise.resolve() : once(socket, 'close')
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all(closures);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('LISTENER_UNKNOWN');
    const original = connect({ host: '127.0.0.1', port: address.port });
    sockets.add(original);
    original.once('close', () => sockets.delete(original));
    const connected = once(original, 'connect');
    original.on('error', () => {});
    await connected;
    await acquisition;
    const closed = once(original, 'close');
    original.write(bytes);
    await expect(classified).rejects.toBeDefined();
    await closed;
  }
);

it('real broker CONNECT validates inner upgrade, exchanges text and closes on original revocation', async () => {
  const { createServer: createHTTPServer } = await import('node:http');
  const { WebSocket, WebSocketServer } = await import('ws');
  const { createNodeBrokerTransport } = await import('../node-transport.js');
  const originSockets = new Set<Socket>();
  let connections = 0,
    upgrades = 0;
  const origin = createHTTPServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  origin.on('connection', (socket) => {
    connections++;
    originSockets.add(socket);
    socket.once('close', () => originSockets.delete(socket));
  });
  origin.on('upgrade', (request, socket, head) => {
    upgrades++;
    expect(request.headers['proxy-authorization']).toBeUndefined();
    websocketServer.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data, binary) => {
        expect(binary).toBe(false);
        expect(data.toString()).toBe('BOUND');
        ws.send(data.toString());
      });
    });
  });
  onTestFinished(async () => {
    const originalCloses = [...originSockets].map((socket) => once(socket, 'close'));
    for (const socket of originSockets) socket.destroy();
    await Promise.all(originalCloses);
    websocketServer.close();
    await new Promise<void>((resolve, reject) =>
      origin.close((error) => (error ? reject(error) : resolve()))
    );
  });
  const listening = once(origin, 'listening');
  origin.listen(0, '127.0.0.1');
  await listening;
  const address = origin.address();
  if (!address || typeof address === 'string') throw Error('ORIGIN_UNKNOWN');
  const f = await fixture(),
    broker = f.create(createNodeBrokerTransport());
  const descriptor = await broker.start();
  broker.grantLocal(`ws://127.0.0.1:${address.port}/`, 'websocket-connect', 30000);
  const client = connect({ host: '127.0.0.1', port: Number(new URL(descriptor.server).port) });
  const clientClose = once(client, 'close');
  onTestFinished(async () => {
    client.destroy();
    await clientClose;
  });
  await once(client, 'connect');
  const ready = new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const data = (bytes: Buffer) => {
      chunks.push(bytes);
      if (!Buffer.concat(chunks).includes('\r\n\r\n')) return;
      client.off('data', data);
      if (Buffer.concat(chunks).toString() !== 'HTTP/1.1 200 Connection Established\r\n\r\n')
        reject(Error('CONNECT_RESPONSE'));
      else resolve();
    };
    client.on('data', data);
    client.once('error', reject);
  });
  client.write(
    `CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nProxy-Authorization: Bearer ${descriptor.credential}\r\n\r\n`
  );
  await ready;
  expect(connections).toBe(0);
  const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/socket`, {
    createConnection: () => client,
  });
  const websocketClose = once(websocket, 'close');
  websocket.on('error', () => {});
  await once(websocket, 'open');
  const message = once(websocket, 'message');
  websocket.send('BOUND');
  const [payload, binary] = await message;
  expect(payload.toString()).toBe('BOUND');
  expect(binary).toBe(false);
  expect(connections).toBe(1);
  expect(upgrades).toBe(1);
  expect(f.resolver).not.toHaveBeenCalled();
  f.issuer.revoke(f.run);
  await websocketClose;
  await clientClose;
  expect(await broker.close()).toBe(true);
});

it.each(denied)(
  'real broker denies %s on accepted original before numeric dial',
  async (_name, bytes) => {
    const { createNodeBrokerTransport } = await import('../node-transport.js');
    const transport = createNodeBrokerTransport();
    const dial = vi.fn(transport.dial);
    const f = await fixture(),
      broker = f.create({ ...transport, dial });
    const descriptor = await broker.start();
    broker.grantLocal('ws://127.0.0.1:43124/', 'websocket-connect', 30000);
    const client = connect({ host: '127.0.0.1', port: Number(new URL(descriptor.server).port) });
    const closed = once(client, 'close');
    client.on('error', () => {});
    onTestFinished(async () => {
      client.destroy();
      await closed;
    });
    await once(client, 'connect');
    const ready = once(client, 'data');
    client.write(
      `CONNECT 127.0.0.1:43124 HTTP/1.1\r\nHost: 127.0.0.1:43124\r\nProxy-Authorization: Bearer ${descriptor.credential}\r\n\r\n`
    );
    const [response] = await ready;
    expect(response.toString()).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');
    client.write(bytes);
    await closed;
    expect(dial).not.toHaveBeenCalled();
    expect(f.resolver).not.toHaveBeenCalled();
    expect(await broker.close()).toBe(true);
  }
);

it('special capability refuses public, TLS and same-endpoint wrong-transport issuance', async () => {
  const f = await fixture();
  expect(() => f.broker.grantLocal('ws://example.test/', 'websocket-connect', 30000)).toThrow();
  expect(() => f.broker.grantLocal('wss://127.0.0.1:43124/', 'websocket-connect', 30000)).toThrow();
  expect(() =>
    f.broker.grantLocal('https://127.0.0.1:43124/', 'websocket-connect', 30000)
  ).toThrow();
});
