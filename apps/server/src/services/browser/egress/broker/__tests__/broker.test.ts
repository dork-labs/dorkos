import { createHash } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { FakeSocket, FakeBody } from './fake-transport.js';
import { fixture, turns } from './broker-fixture.js';
it('peer-checked opaque tunnel forwards both directions then revocation prevents further bytes', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  expect(f.fake.origins).toHaveLength(1);
  expect(client.writes.join('')).toContain('200 Connection Established');
  client.emit('client-challenge');
  f.fake.origins[0]!.emit('origin-challenge');
  expect(f.fake.origins[0]!.writes).toEqual(['client-challenge']);
  expect(client.writes.join('')).toContain('origin-challenge');
  f.issuer.revoke(f.run);
  expect(client.observedClosed).toBe(true);
  expect(f.fake.origins[0]!.observedClosed).toBe(true);
  client.emit('forbidden');
  expect(f.fake.origins[0]!.writes).toEqual(['client-challenge']);
  expect(await f.broker.close()).toBe(true);
  expect(f.issuer.ledger.snapshot().circuits).toBe(0);
});
it('wrong peer produces zero origin and CONNECT200 bytes', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  vi.mocked(f.fake.transport.dial).mockResolvedValue({
    socket: new FakeSocket({ address: '1.1.1.1', family: 4, port: 443 }),
    outcome: 'connected',
  });
  f.fake.accept(client, f.request());
  await turns();
  expect(client.writes).toEqual([]);
  expect(client.observedClosed).toBe(true);
  await f.broker.close();
});
it('duplicate authentication and denied admin authority refuse before dial', async () => {
  const f = await fixture(),
    a = new FakeSocket(),
    b = new FakeSocket();
  f.fake.accept(
    a,
    f.request('CONNECT', 'example.test:443', ['Proxy-Authorization', 'Bearer secret'])
  );
  f.fake.accept(b, {
    raw: {
      method: 'GET',
      target: 'http://admin.example/',
      head: new Uint8Array(),
      rawHeaders: [
        'Host',
        'admin.example',
        'Proxy-Authorization',
        'Bearer ' + f.descriptor.credential,
      ],
    },
    body: new FakeBody(),
  });
  await turns();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(a.observedClosed && b.observedClosed).toBe(true);
  await f.broker.close();
});

it('a valid websocket101 carries both bounded heads and checks actual accept digest', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
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
    head: Buffer.from('origin-head'),
  });
  const request = f.request('GET', 'ws://example.test/', [
    'Connection',
    'Upgrade',
    'Upgrade',
    'websocket',
    'Sec-WebSocket-Key',
    key,
    'Sec-WebSocket-Version',
    '13',
  ]);
  request.raw.head = Buffer.from('client-head');
  f.fake.accept(client, request);
  await turns();
  expect(client.writes.join('')).toContain('101 Origin');
  expect(client.writes.join('')).toContain('origin-head');
  expect(f.fake.origins[0]!.writes).toEqual(['client-head']);
  client.emit('next');
  expect(f.fake.origins[0]!.writes).toEqual(['client-head', 'next']);
});
it('wrong websocket101 digest refuses before response/head bytes', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  vi.mocked(f.fake.transport.exchange).mockResolvedValue({
    status: 101,
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
    websocketAccept: 'wrong',
    body: new FakeBody(),
    head: Buffer.from('forbidden'),
  });
  f.fake.accept(
    client,
    f.request('GET', 'ws://example.test/', [
      'Connection',
      'Upgrade',
      'Upgrade',
      'websocket',
      'Sec-WebSocket-Key',
      'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version',
      '13',
    ])
  );
  await turns();
  expect(client.writes).toEqual([]);
  expect(client.observedClosed).toBe(true);
});
it('localHTTP grant never authorizes opaqueCONNECT to the same numeric endpoint', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.broker.grantLocal('http://127.0.0.1:43210', 'http', 5000);
  f.fake.accept(client, f.request('CONNECT', '127.0.0.1:43210'));
  await turns();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(client.writes).toEqual([]);
});
it('mixed resolver answers refuse before dial and never expose origin bytes', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.resolver.mockResolvedValue({ a: ['8.8.8.8', '127.0.0.1'], aaaa: [], cname: [] });
  f.fake.accept(client, f.request());
  await turns();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(client.writes).toEqual([]);
  expect(client.observedClosed).toBe(true);
});
it('same client second request closes the first circuit without replay or second DNS', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  // Reusing a ticket cannot create another intake; exercise the transport pipeline notification through a second request.
  f.fake.pipeline(client);
  await turns();
  expect(client.observedClosed).toBe(true);
  expect(f.resolver).toHaveBeenCalledTimes(1);
  expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
});
it('dial receives a numeric endpoint and a lookup callback that cannot start second DNS', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  vi.mocked(f.fake.transport.dial).mockImplementation(async (endpoint, o) => {
    expect(endpoint.address).toBe('8.8.8.8');
    expect(o.autoSelectFamily).toBe(false);
    expect(() => o.lookup()).toThrow('PEER_REFUSED');
    const socket = new FakeSocket(endpoint);
    o.onSocket(socket);
    return { socket, outcome: 'connected' };
  });
  f.fake.accept(client, f.request());
  await turns();
  expect(client.writes.join('')).toContain('200');
  expect(f.resolver).toHaveBeenCalledTimes(1);
});
