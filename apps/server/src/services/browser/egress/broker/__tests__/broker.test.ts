import { createHash } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { FakeSocket, FakeBody } from './fake-transport.js';
import { fixture, turns } from './broker-fixture.js';
import { forwardFlow, guardedWrite } from '../flow.js';
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
it('held ignored-abort dial remains charged until actual late socket closure', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let resolve!: (s: { socket: FakeSocket; outcome: 'connected' }) => void;
  vi.mocked(f.fake.transport.dial).mockImplementation(
    () => new Promise((done) => (resolve = done))
  );
  const client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  f.issuer.revoke(f.run);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.issuer.ledger.snapshot().circuits).toBe(1);
  const late = new FakeSocket({ address: '8.8.8.8', family: 4, port: 443 });
  late.closeHeld = true;
  resolve({ socket: late, outcome: 'connected' });
  await turns();
  expect(f.issuer.ledger.snapshot().circuits).toBe(1);
  late.closed();
  await turns();
  expect(f.issuer.ledger.snapshot().circuits).toBe(0);
  expect(client.writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(5000);
});
it('unobserved listener closure cannot certify stopped', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.fake.holdListener();
  const closed = f.broker.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await closed).toBe(false);
  expect(f.issuer.ledger.snapshot().listeners).toBe(1);
  f.fake.closeListener();
  expect(f.issuer.ledger.snapshot().listeners).toBe(0);
  expect(await f.broker.close()).toBe(false);
});
it('unreturned intake acquisition remains charged through close and late observed cleanup', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const slot = f.fake.reserve()!;
  expect(f.broker.status().prepared).toBe(1);
  const close = f.broker.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await close).toBe(false);
  expect(f.issuer.ledger.snapshot().unauthenticated).toBe(1);
  const socket = new FakeSocket();
  expect(f.fake.register(slot, socket)).toBe(false);
  expect(socket.observedClosed).toBe(true);
  expect(f.issuer.ledger.snapshot().unauthenticated).toBe(0);
  expect(await f.broker.close()).toBe(false);
});
it('copied intake admission has no custody authority or foreign cleanup', async () => {
  const f = await fixture(),
    slot = f.fake.reserve()!,
    socket = new FakeSocket();
  expect(f.fake.register({ ...slot }, socket)).toBe(false);
  expect(socket.observedClosed).toBe(false);
  expect(f.fake.register(slot, socket)).toBe(true);
  socket.closed();
  await turns();
  expect(await f.broker.close()).toBe(true);
});
it('all owned socket destroys are attempted even when one cleanup throws', async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  client.destroyThrows = true;
  const close = f.broker.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await close).toBe(false);
  expect(f.fake.origins[0]!.observedClosed).toBe(true);
  expect(f.issuer.ledger.snapshot().circuits).toBe(1);
  client.destroyThrows = false;
  client.closed();
  await turns();
  expect(f.issuer.ledger.snapshot().circuits).toBe(0);
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
it('CONNECT initial backpressure pauses origin until checked drain', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  client.backpressure = true;
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  expect(origin.paused).toBe(true);
  origin.emit('queued');
  expect(client.writes).toHaveLength(1);
  client.backpressure = false;
  client.drain();
  expect(client.writes.join('')).toContain('queued');
  expect(origin.paused).toBe(false);
});
it('one circuit plus held unobserved cleanup still refuses a successor before dial', async () => {
  const f = await fixture({ browserCircuits: 1 }),
    a = new FakeSocket(),
    b = new FakeSocket();
  f.fake.accept(a, f.request());
  await turns();
  a.closeHeld = true;
  f.fake.origins[0]!.closeHeld = true;
  f.fake.accept(b, f.request());
  await turns();
  expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
  expect(b.observedClosed).toBe(true);
  a.closed();
  f.fake.origins[0]!.closed();
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
it('local tunnel grant expiry closes actual owned circuit despite renewed run', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.broker.grantLocal('https://127.0.0.1:43210', 'opaque-connect', 1000);
  f.fake.accept(client, f.request('CONNECT', '127.0.0.1:43210'));
  await turns();
  expect(client.writes.join('')).toContain('200');
  const permit = await f.issuer.continuation(f.run, 0);
  f.issuer.consume(f.run, 0, permit);
  f.setTime(1001);
  client.emit('forbidden');
  expect(f.fake.origins[0]!.writes).toEqual([]);
  expect(client.observedClosed).toBe(true);
});
it('live public run continuation retains the same circuit and cumulative duplex counter', async () => {
  const f = await fixture({ duplexBytes: 43 }),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  client.emit('abc');
  expect(origin.writes).toEqual(['abc']);
  const permit = await f.issuer.continuation(f.run, 0);
  f.issuer.consume(f.run, 0, permit);
  expect(client.observedClosed).toBe(false);
  expect(f.fake.origins).toHaveLength(1);
  client.emit('xy');
  expect(origin.writes).toEqual(['abc']);
  expect(client.observedClosed).toBe(true);
});

it('unstarted private broker records are bounded and release only known no-acquisition slots', async () => {
  const f = await fixture({ listeners: 2 }),
    other = f.create();
  expect(() => f.create()).toThrow('QUOTA');
  expect(f.issuer.ledger.snapshot().listeners).toBe(2);
  expect(await other.close()).toBe(true);
  expect(f.issuer.ledger.snapshot().listeners).toBe(0);
  expect(() => f.create()).toThrow(); // closing the principal is terminal for every attached broker
});
it('unknown live authority prevents credentialed successor and closes the existing tunnel', async () => {
  const f = await fixture(),
    a = new FakeSocket(),
    b = new FakeSocket();
  f.fake.accept(a, f.request());
  await turns();
  f.invalidate();
  a.emit('forbidden');
  expect(f.fake.origins[0]!.writes).toEqual([]);
  expect(a.observedClosed).toBe(true);
  expect(f.fake.accept(b, f.request())).toBe(false);
  expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
});
it('suspension closes prior circuits then opaque fresh revision rebind retains listener and original lease', async () => {
  const f = await fixture(),
    a = new FakeSocket();
  f.fake.accept(a, f.request());
  await turns();
  const deadline = f.issuer.snapshot(f.run).deadline;
  f.broker.suspend();
  expect(a.observedClosed).toBe(true);
  await turns();
  f.setRevision(2);
  const permit = await f.issuer.revisionPermit(f.run, 0);
  expect(() => f.broker.rebind(f.policyOptions(), 0, { ...permit })).toThrow('PERMIT_REFUSED');
  f.broker.rebind(f.policyOptions(), 0, permit);
  expect(f.issuer.snapshot(f.run).deadline).toBe(deadline);
  expect(f.fake.transport.listen).toHaveBeenCalledTimes(1);
  f.broker.grantLocal('https://127.0.0.1:43210', 'opaque-connect', 1000);
  const b = new FakeSocket();
  f.fake.accept(b, f.request('CONNECT', '127.0.0.1:43210'));
  await turns();
  expect(b.writes.join('')).toContain('200');
});
it('held old circuit blocks rebind even with a fresh exact revision permit', async () => {
  const f = await fixture(),
    a = new FakeSocket();
  f.fake.accept(a, f.request());
  await turns();
  a.closeHeld = true;
  f.broker.suspend();
  f.setRevision(2);
  const permit = await f.issuer.revisionPermit(f.run, 0);
  expect(() => f.broker.rebind(f.policyOptions(), 0, permit)).toThrow('CLOSED');
  a.closed();
  await turns();
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

it('actual broker revocation during writableBytes observation prevents current origin IO', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  let observed = false;
  Object.defineProperty(origin, 'writableBytes', {
    get() {
      observed = true;
      f.issuer.revoke(f.run);
      return 0;
    },
  });
  client.emit('after-revoke');
  expect(observed).toBe(true);
  expect(client.observedClosed).toBe(true);
  expect(origin.observedClosed).toBe(true);
  expect(origin.writes, 'ACTUAL_BROKER_IO_AFTER_REVOKE').toEqual([]);
});
it.each(['header', 'head', 'resume'] as const)(
  'reentrant %s method observation cannot perform post-revocation IO',
  async (where) => {
    const f = await fixture(),
      client = new FakeSocket();
    let observed = 0,
      calls = 0;
    const method = where === 'resume' ? 'resume' : 'write';
    const target =
      where === 'head' ? new FakeSocket({ address: '8.8.8.8', family: 4, port: 443 }) : client;
    Object.defineProperty(target, method, {
      get() {
        observed++;
        f.issuer.revoke(f.run);
        return () => {
          calls++;
          return true;
        };
      },
    });
    if (where === 'head')
      vi.mocked(f.fake.transport.dial).mockResolvedValue({ socket: target, outcome: 'connected' });
    const request = where === 'header' ? f.request('GET', 'http://example.test/path') : f.request();
    if (where === 'head') request.raw.head = Buffer.from('initial-challenge');
    f.fake.accept(client, request);
    await turns();
    expect(observed).toBe(1);
    expect(calls, 'IO_METHOD_AFTER_REVOKE').toBe(0);
    expect(client.observedClosed).toBe(true);
    expect(f.issuer.ledger.snapshot().circuits).toBe(0);
  }
);

it('ordinary response preserves final queued body before ending a header-backpressured client', async () => {
  const f = await fixture();
  const client = new FakeSocket();
  client.backpressure = true;
  expect(f.fake.accept(client, f.request('GET', 'http://example.test/path'))).toBe(true);
  await turns();
  expect(f.fake.transport.exchange).toHaveBeenCalledTimes(1);
  expect(f.fake.responseBody.paused).toBe(true);
  f.fake.responseBody.emit('FINAL_RESPONSE_CHALLENGE');
  f.fake.responseBody.finish();
  expect(client.observedClosed, 'PREMATURE_END_BEFORE_QUEUED_RESPONSE_DRAIN').toBe(false);
  client.backpressure = false;
  client.drain();
  await turns();
  expect(client.writes.join(''), 'FINAL_RESPONSE_BODY_LOST').toContain('FINAL_RESPONSE_CHALLENGE');
  expect(client.observedClosed).toBe(true);
});
it('ordinary response unblocked completion delivers exact body and closes', async () => {
  const f = await fixture();
  const client = new FakeSocket();
  expect(f.fake.accept(client, f.request('GET', 'http://example.test/path'))).toBe(true);
  await turns();
  f.fake.responseBody.emit('UNBLOCKED_RESPONSE_CHALLENGE');
  f.fake.responseBody.finish();
  expect(client.writes.join('')).toContain('UNBLOCKED_RESPONSE_CHALLENGE');
  expect(client.observedClosed).toBe(true);
});

it('ordinary response queue drains correctly while end remains withheld', async () => {
  const f = await fixture();
  const client = new FakeSocket();
  client.backpressure = true;
  f.fake.accept(client, f.request('GET', 'http://example.test/path'));
  await turns();
  f.fake.responseBody.emit('QUEUED_RESPONSE_CHALLENGE');
  expect(client.writes.join('')).not.toContain('QUEUED_RESPONSE_CHALLENGE');
  expect(client.observedClosed).toBe(false);
  client.backpressure = false;
  client.drain();
  expect(client.writes.join('')).toContain('QUEUED_RESPONSE_CHALLENGE');
  f.fake.responseBody.finish();
  expect(client.observedClosed).toBe(true);
});
it('ordinary body-write backpressure preserves subsequent queued final bytes at EOF', async () => {
  const f = await fixture();
  const client = new FakeSocket();
  f.fake.accept(client, f.request('GET', 'http://example.test/path'));
  await turns();
  client.backpressure = true;
  f.fake.responseBody.emit('FIRST_BODY_CHUNK');
  expect(client.writes.join('')).toContain('FIRST_BODY_CHUNK');
  expect(f.fake.responseBody.paused).toBe(true);
  f.fake.responseBody.emit('LAST_BODY_CHUNK');
  f.fake.responseBody.finish();
  client.backpressure = false;
  client.drain();
  expect(client.writes.join(''), 'BODY_WRITE_BACKPRESSURE_LOST_FINAL_CHUNK').toContain(
    'LAST_BODY_CHUNK'
  );
});

it('quality closed-during-write-getter refuses current broker bytes', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  let reached = 0;
  Object.defineProperty(origin, 'write', {
    get() {
      reached++;
      origin.closed();
      return FakeSocket.prototype.write;
    },
  });
  client.emit('closed-challenge');
  expect(reached).toBe(1);
  expect(origin.observedClosed).toBe(true);
  expect(origin.writes, 'CLOSED_TARGET_WRITE').toEqual([]);
});
it('quality throwing cleanup pause still closes both actual owned broker mocks', async () => {
  const f = await fixture({ duplexBytes: 41 }),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  expect(client.writes.join('')).toContain('200');
  let pauses = 0;
  client.pause = () => {
    pauses++;
    throw Error('owned-pause-failed');
  };
  try {
    client.emit('xxx');
  } catch {}
  expect(pauses).toBe(1);
  expect(origin.writes).toEqual([]);
  expect(origin.observedClosed, 'PAUSE_THROW_SKIPPED_OWNED_CLOSE').toBe(true);
  expect(client.observedClosed).toBe(true);
});
it('quality ordinary current broker has observable bidirectional positive', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  client.emit('forward');
  origin.emit('reverse');
  expect(origin.writes).toEqual(['forward']);
  expect(client.writes.join('')).toContain('reverse');
});
it('quality exact buffer plus one refuses while ordinary exact boundary writes', () => {
  const target = new FakeSocket();
  target.writableBytes = 2;
  let checks = 0;
  expect(guardedWrite(target, Buffer.from('abc'), () => checks++, 5)).toBe(true);
  expect(() => guardedWrite(target, Buffer.from('abcd'), () => checks++, 5)).toThrow('BYTE_LIMIT');
  expect(checks).toBe(2);
  expect(target.writes).toEqual(['abc']);
});
it('quality method observation revocation denies write with receiver intact positive', () => {
  const t = new FakeSocket();
  let current = true,
    seen = 0;
  Object.defineProperty(t, 'write', {
    get() {
      seen++;
      current = false;
      return FakeSocket.prototype.write;
    },
  });
  expect(() =>
    guardedWrite(
      t,
      Buffer.from('deny'),
      () => {
        if (!current) throw Error('retired');
      },
      100
    )
  ).toThrow('retired');
  expect(seen).toBe(1);
  expect(t.writes).toEqual([]);
  const p = new FakeSocket();
  guardedWrite(p, Buffer.from('allow'), () => {}, 100);
  expect(p.writes).toEqual(['allow']);
});
it('quality failed flow pause must still notify terminal owner once', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let pauses = 0,
    failures = 0;
  const f = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 1,
    queueLimit: 5,
    onFailure: () => failures++,
  });
  source.pause = () => {
    pauses++;
    throw Error('pause-failure');
  };
  try {
    source.emit('xx');
  } catch {}
  expect(pauses).toBe(1);
  expect(target.writes).toEqual([]);
  expect(failures, 'TERMINAL_OWNER_NOT_NOTIFIED').toBe(1);
  f.stop();
});

it('broker terminal detachment failure attempts both owned closes and retains unobserved charge', async () => {
  const f = await fixture({ duplexBytes: 41 }),
    client = new FakeSocket();
  let detachments = 0;
  const original = client.onData;
  client.onData = (fn) => {
    const remove = Reflect.apply(original, client, [fn]);
    return () => {
      detachments++;
      remove();
      throw Error('DETACH_FAILED');
    };
  };
  client.closeHeld = true;
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  origin.closeHeld = true;
  let clientDestroy = 0,
    originDestroy = 0;
  const closeClient = client.destroy,
    closeOrigin = origin.destroy;
  client.destroy = () => {
    clientDestroy++;
    Reflect.apply(closeClient, client, []);
  };
  origin.destroy = () => {
    originDestroy++;
    Reflect.apply(closeOrigin, origin, []);
  };
  client.emit('xxx');
  expect(detachments).toBe(1);
  expect(clientDestroy).toBe(1);
  expect(originDestroy).toBe(1);
  expect(origin.writes).toEqual([]);
  expect(f.broker.status().ledger.circuits).toBe(1);
  expect(client.observedClosed).toBe(false);
  expect(origin.observedClosed).toBe(false);
  client.emit('late');
  origin.emit('late');
  expect(origin.writes).toEqual([]);
  expect(clientDestroy).toBe(1);
  expect(originDestroy).toBe(1);
  client.closed();
  origin.closed();
  await turns();
  expect(f.broker.status().ledger.circuits).toBe(0);
});
it('ordinary pending EOF revocation closes attributable endpoints without draining challenge', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  client.backpressure = true;
  f.fake.accept(client, f.request('GET', 'http://example.test/path'));
  await turns();
  f.fake.responseBody.emit('REVOKED_QUEUE');
  f.fake.responseBody.finish();
  expect(client.observedClosed).toBe(false);
  f.invalidate();
  client.backpressure = false;
  client.drain();
  await turns();
  expect(client.writes.join('')).not.toContain('REVOKED_QUEUE');
  expect(client.observedClosed).toBe(true);
  expect(f.fake.origins[0]!.observedClosed).toBe(true);
});

it('final write authority clock closure synchronously retires exact circuit before IO', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  let armed = false,
    captures = 0,
    closes = 0;
  Object.defineProperty(origin, 'write', {
    get() {
      captures++;
      armed = true;
      return FakeSocket.prototype.write;
    },
  });
  f.observeClock(() => {
    if (armed) {
      armed = false;
      closes++;
      origin.closed();
    }
  });
  client.emit('AFTER_CLOCK_CLOSE');
  expect(captures).toBe(1);
  expect(closes).toBe(1);
  expect(origin.observedClosed).toBe(true);
  expect(origin.writes, 'CLOCK_CLOSED_TARGET_STALE_WRITE').toEqual([]);
  expect(client.observedClosed).toBe(true);
});
it('same final write clock observation keeps open target forwarding positive', async () => {
  const f = await fixture(),
    client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  const origin = f.fake.origins[0]!;
  let captures = 0,
    observations = 0;
  Object.defineProperty(origin, 'write', {
    get() {
      captures++;
      return FakeSocket.prototype.write;
    },
  });
  f.observeClock(() => observations++);
  client.emit('CURRENT_CLOCK_TARGET');
  expect(captures).toBe(1);
  expect(observations).toBeGreaterThan(0);
  expect(origin.writes).toEqual(['CURRENT_CLOCK_TARGET']);
  expect(origin.observedClosed).toBe(false);
});

it.each([true, false])(
  'ordinary initial resume shares synchronous EOF state (EOF=%s)',
  async (eof) => {
    const f = await fixture({ cleanupMs: 1 }),
      client = new FakeSocket();
    let ends = 0,
      resumes = 0;
    client.end = () => ends++;
    client.closeHeld = true;
    const body = f.fake.responseBody;
    body.onEnd = (callback) => {
      body.end.add(callback);
      if (eof) callback();
      return () => body.end.delete(callback);
    };
    body.resume = function () {
      expect(this).toBe(body);
      resumes++;
    };
    f.fake.accept(client, f.request('GET', 'http://example.test/'));
    await turns();
    expect(ends).toBe(eof ? 1 : 0);
    expect(resumes).toBe(eof ? 0 : 1);
    body.finish();
    expect(ends).toBe(1);
    expect(resumes).toBe(eof ? 0 : 1);
    client.closed();
    await f.broker.close();
  }
);

it.each([1, 2])(
  'startup clock reentry depth=%s retains one listener acquisition',
  async (depth) => {
    const f = await fixture({ cleanupMs: 10 });
    const broker = f.create();
    const nested: ReturnType<typeof broker.start>[] = [];
    let remaining = depth;
    f.observeClock(() => {
      if (remaining > 0) {
        remaining--;
        const pending = broker.start();
        nested.push(pending);
        void pending.catch(() => {});
      }
    });
    const outer = broker.start();
    const outcomes = await Promise.allSettled([outer, ...nested]);
    expect(nested).toHaveLength(depth);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.fake.transport.listen, 'STARTUP_REENTRY_DUPLICATE_LISTEN').toHaveBeenCalledTimes(2);
    expect(f.issuer.ledger.snapshot().listeners).toBe(2);
    await expect(broker.start()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(f.fake.transport.listen).toHaveBeenCalledTimes(2);
    await broker.close();
  }
);
it('startup ordinary clock observations preserve single acquisition and credential use', async () => {
  const f = await fixture({ cleanupMs: 10 });
  const broker = f.create();
  let observations = 0;
  f.observeClock(() => observations++);
  const result = await broker.start();
  expect(observations).toBeGreaterThan(0);
  expect(result.server).toBe('http://127.0.0.1:43123');
  expect(result.credential.length).toBeGreaterThan(0);
  expect(f.fake.transport.listen).toHaveBeenCalledTimes(2);
  await expect(broker.start()).rejects.toMatchObject({ code: 'CLOSED' });
  expect(f.fake.transport.listen).toHaveBeenCalledTimes(2);
  await broker.close();
});
it('startup listen getter reentry cannot acquire another listener', async () => {
  const f = await fixture({ cleanupMs: 10 });
  const broker = f.create();
  const native = f.fake.transport.listen;
  let nested: ReturnType<typeof broker.start> | undefined;
  Object.defineProperty(f.fake.transport, 'listen', {
    get() {
      nested = broker.start();
      void nested.catch(() => {});
      return native;
    },
  });
  await broker.start();
  await expect(nested).rejects.toMatchObject({ code: 'CLOSED' });
  expect(native).toHaveBeenCalledTimes(2);
  await broker.close();
});

it.each(['stable', 'address', 'port', 'queued-address', 'queued-port', 'post-metadata-clock'])(
  'startup metadata and credential final delivery %s',
  async (mode) => {
    const f = await fixture({ cleanupMs: 10 });
    const broker = f.create();
    let addresses = 0,
      ports = 0,
      retired = false,
      armed = false;
    const retire = () => {
      retired = true;
      void broker.close();
    };
    if (mode === 'post-metadata-clock')
      f.observeClock(() => {
        if (armed) {
          armed = false;
          retire();
        }
      });
    Object.defineProperty(f.fake.listener, 'address', {
      get() {
        addresses++;
        if (mode === 'address') retire();
        if (mode === 'queued-address') queueMicrotask(retire);
        return '127.0.0.1';
      },
    });
    Object.defineProperty(f.fake.listener, 'port', {
      get() {
        ports++;
        if (mode === 'port') retire();
        if (mode === 'queued-port') queueMicrotask(retire);
        if (mode === 'post-metadata-clock') armed = true;
        return 43123;
      },
    });
    const [outcome] = await Promise.allSettled([broker.start()]);
    expect(addresses).toBeGreaterThan(0);
    expect(ports).toBeGreaterThan(0);
    if (mode === 'stable') {
      expect(outcome).toMatchObject({
        status: 'fulfilled',
        value: { server: 'http://127.0.0.1:43123' },
      });
      expect(f.fake.transport.listen).toHaveBeenCalledTimes(2);
    } else {
      expect(retired).toBe(true);
      expect(outcome, 'STARTUP_CREDENTIAL_AFTER_METADATA_RETIREMENT').toMatchObject({
        status: 'rejected',
      });
    }
    await broker.close();
  }
);

it('startup captures valid listener metadata once and transfers credential once', async () => {
  const f = await fixture({ cleanupMs: 10 });
  const broker = f.create();
  let addresses = 0,
    ports = 0;
  Object.defineProperty(f.fake.listener, 'address', {
    get() {
      addresses++;
      return '127.0.0.1';
    },
  });
  Object.defineProperty(f.fake.listener, 'port', {
    get() {
      ports++;
      return 43123;
    },
  });
  const descriptor = await broker.start();
  expect(descriptor.server).toBe('http://127.0.0.1:43123');
  expect(descriptor.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect([addresses, ports]).toEqual([1, 1]);
  await expect(broker.start()).rejects.toMatchObject({ code: 'CLOSED' });
  expect([addresses, ports]).toEqual([1, 1]);
  await broker.close();
});
