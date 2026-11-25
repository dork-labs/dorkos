import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { fixture, turns } from './broker-fixture.js';
import { FakeBody, FakeSocket } from './fake-transport.js';

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

it('special capability refuses public, TLS and same-endpoint wrong-transport issuance', async () => {
  const f = await fixture();
  expect(() => f.broker.grantLocal('ws://example.test/', 'websocket-connect', 30000)).toThrow();
  expect(() => f.broker.grantLocal('wss://127.0.0.1:43124/', 'websocket-connect', 30000)).toThrow();
  expect(() =>
    f.broker.grantLocal('https://127.0.0.1:43124/', 'websocket-connect', 30000)
  ).toThrow();
});
