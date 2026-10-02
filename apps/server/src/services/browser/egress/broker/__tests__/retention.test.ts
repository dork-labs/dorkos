import { createPrivateBroker } from '../broker.js';
import { createBrokerIssuer } from '../issuer.js';
import { it, expect, vi } from 'vitest';
import { fixture, turns } from './broker-fixture.js';
import { FakeSocket, fakeTransport } from './fake-transport.js';
it('unsettled resolver remains charged after its policy timeout and actual owned close', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let resolve!: (v: Awaited<ReturnType<typeof f.resolver>>) => void;
  f.resolver.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const client = new FakeSocket();
  f.fake.accept(client, f.request());
  await turns();
  await vi.advanceTimersByTimeAsync(501);
  await turns();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(client.observedClosed).toBe(true);
  expect(f.issuer.ledger.snapshot().circuits).toBe(1);
  resolve({ a: ['8.8.8.8'], aaaa: [], cname: [] });
  await turns();
  expect(f.issuer.ledger.snapshot().circuits).toBe(0);
  expect(client.writes).toEqual([]);
});
it('global circuit capacity is shared across two private brokers, including held cleanup', async () => {
  const f = await fixture({ globalCircuits: 1 }),
    g = fakeTransport(),
    second = f.create(g.transport);
  const descriptor = await second.start();
  const a = new FakeSocket(),
    b = new FakeSocket();
  f.fake.accept(a, f.request());
  await turns();
  a.closeHeld = true;
  const request = f.request();
  request.raw.rawHeaders[3] = 'Bearer ' + descriptor.credential;
  g.accept(b, request);
  await turns();
  expect(g.transport.dial).not.toHaveBeenCalled();
  expect(b.observedClosed).toBe(true);
  expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
  a.closed();
});
it('listener callback throwing without attributable returned listener remains quarantined', async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    other = f.create();
  vi.mocked(f.fake.transport.listen).mockImplementation(async () => {
    throw Error('secret-network-address');
  });
  const starting = other.start();
  const rejected = expect(starting).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await turns();
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(other.status()).toMatchObject({ listenerSettled: true, listenerClosed: false });
  expect(f.issuer.ledger.snapshot().listeners).toBe(1);
  expect(await other.close()).toBe(false);
});
it('late listener return cannot publish descriptor or heal timed-out close', async () => {
  vi.useFakeTimers();
  const f = await fixture(),
    other = f.create();
  let resolve!: (l: typeof f.fake.listener) => void;
  vi.mocked(f.fake.transport.listen).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const starting = other.start();
  const rejected = expect(starting).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await turns();
  await vi.advanceTimersByTimeAsync(7000);
  await rejected;
  expect(other.status().listenerClosed).toBe(false);
  resolve(f.fake.listener);
  await turns();
  expect(other.status().listenerClosed).toBe(true);
  expect(await other.close()).toBe(false);
  expect(f.issuer.ledger.snapshot().listeners).toBe(0);
});
it('oversized CONNECT buffered head refuses before authority resolver/dial', async () => {
  const f = await fixture({ queueBytes: 3 }),
    client = new FakeSocket(),
    request = f.request();
  request.raw.head = Buffer.from('1234');
  f.fake.accept(client, request);
  await turns();
  expect(f.resolver).not.toHaveBeenCalled();
  expect(f.fake.transport.dial).not.toHaveBeenCalled();
  expect(client.writes).toEqual([]);
});
it('predecessor/copied credential never authorizes current broker', async () => {
  const f = await fixture(),
    client = new FakeSocket(),
    request = f.request();
  request.raw.rawHeaders[3] = 'Bearer predecessor';
  f.fake.accept(client, request);
  await turns();
  expect(f.resolver).not.toHaveBeenCalled();
  expect(client.observedClosed).toBe(true);
});

const binding = {
  ownerId: 'owner',
  workspaceId: 'workspace',
  browserId: 'browser',
  browserGeneration: 1,
};
function issuerFixture() {
  let tick = 0;
  let hook: (() => void) | undefined;
  let complete = true;
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: true as const,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'fixture',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    monotonicNow: tick,
    utcNow: 1000 + tick,
    utcExpiresAt: 100000 + tick,
  });
  const issuer = createBrokerIssuer({
    now: () => {
      hook?.();
      return tick;
    },
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: () => ({
        revision: 1,
        publicAuthoritiesKnown: true,
        localCoverageComplete: complete,
        validUntil: 100000,
        protectedEndpoints: [],
        declaredInstances: ['fixture'],
        coveredInstances: ['fixture'],
      }),
    },
  });
  return {
    issuer,
    hook: (f?: () => void) => {
      hook = f;
    },
    gap: () => {
      complete = false;
    },
    time: (n: number) => {
      tick = n;
    },
  };
}

it('same browser generation cannot mint a second quota namespace', async () => {
  const f = await fixture({ browserCircuits: 1 }),
    run2 = await f.issuer.retainRun(binding),
    g = fakeTransport();
  const second = createPrivateBroker({
    issuer: f.issuer,
    run: run2,
    policy: f.policyOptions(),
    transport: g.transport,
  });
  try {
    const descriptor = await second.start(),
      a = new FakeSocket(),
      b = new FakeSocket();
    f.fake.accept(a, f.request());
    await turns();
    const request = f.request();
    request.raw.rawHeaders[3] = 'Bearer ' + descriptor.credential;
    g.accept(b, request);
    await turns();
    expect(f.fake.transport.dial).toHaveBeenCalledTimes(1);
    expect(g.transport.dial, 'SAME_BROWSER_SECOND_CIRCUIT_DIALED').not.toHaveBeenCalled();
  } finally {
    await second.close();
  }
});
it('same-revision coverage gap suspends an already-live local tunnel', async () => {
  const f = issuerFixture(),
    run = await f.issuer.retainRun(binding),
    g = fakeTransport();
  const broker = createPrivateBroker({
    issuer: f.issuer,
    run,
    policy: {
      revision: 1,
      adminAuthorities: [],
      hostInterfaces: [],
      privateAdminEndpoints: [],
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    },
    transport: g.transport,
  });
  try {
    const descriptor = await broker.start();
    broker.grantLocal('https://127.0.0.1:43210', 'opaque-connect', 10000);
    const client = new FakeSocket();
    g.accept(client, {
      raw: {
        method: 'CONNECT',
        target: '127.0.0.1:43210',
        head: new Uint8Array(),
        rawHeaders: [
          'Host',
          '127.0.0.1:43210',
          'Proxy-Authorization',
          'Bearer ' + descriptor.credential,
        ],
      },
      body: new (await import('./fake-transport.js')).FakeBody(),
    });
    await turns();
    expect(client.writes.join('')).toContain('200');
    f.gap();
    client.emit('gap-challenge');
    expect(g.origins[0]!.writes, 'LOCAL_CHALLENGE_WITH_INCOMPLETE_COVERAGE').toEqual([]);
    expect(client.observedClosed).toBe(true);
  } finally {
    await broker.close();
  }
});
it('matching handles retain browser quota until actual old socket closure', async () => {
  const f = await fixture({ browserCircuits: 1 }),
    run2 = await f.issuer.retainRun(binding),
    g = fakeTransport();
  const second = createPrivateBroker({
    issuer: f.issuer,
    run: run2,
    policy: f.policyOptions(),
    transport: g.transport,
  });
  try {
    const descriptor = await second.start(),
      a = new FakeSocket();
    a.closeHeld = true;
    f.fake.accept(a, f.request());
    await turns();
    f.fake.pipeline(a);
    await turns();
    const request = () => {
      const r = f.request();
      r.raw.rawHeaders[3] = 'Bearer ' + descriptor.credential;
      return r;
    };
    g.accept(new FakeSocket(), request());
    await turns();
    expect(g.transport.dial, 'UNCERTAIN_OLD_HANDLE_FORGAVE_BROWSER_QUOTA').not.toHaveBeenCalled();
    expect(f.issuer.ledger.snapshot().circuits).toBe(1);
    const renewal = await f.issuer.continuation(run2, 0);
    f.issuer.consume(run2, 0, renewal);
    g.accept(new FakeSocket(), request());
    await turns();
    expect(g.transport.dial, 'RENEWAL_RESET_BROWSER_QUOTA').not.toHaveBeenCalled();
    a.closed();
    await turns();
    g.accept(new FakeSocket(), request());
    await turns();
    expect(g.transport.dial).toHaveBeenCalledTimes(1);
  } finally {
    await second.close();
  }
});
it('a same-revision local coverage gap fences pending dial and denies grant reuse', async () => {
  const f = issuerFixture(),
    run = await f.issuer.retainRun(binding),
    g = fakeTransport();
  const broker = createPrivateBroker({
    issuer: f.issuer,
    run,
    policy: {
      revision: 1,
      adminAuthorities: [],
      hostInterfaces: [],
      privateAdminEndpoints: [],
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    },
    transport: g.transport,
  });
  let resolve!: (v: { socket: FakeSocket; outcome: 'connected' }) => void;
  vi.mocked(g.transport.dial).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  try {
    const descriptor = await broker.start();
    broker.grantLocal('https://127.0.0.1:43210', 'opaque-connect', 10000);
    const client = new FakeSocket();
    g.accept(client, {
      raw: {
        method: 'CONNECT',
        target: '127.0.0.1:43210',
        head: new Uint8Array(),
        rawHeaders: [
          'Host',
          '127.0.0.1:43210',
          'Proxy-Authorization',
          'Bearer ' + descriptor.credential,
        ],
      },
      body: new (await import('./fake-transport.js')).FakeBody(),
    });
    await turns();
    expect(g.transport.dial).toHaveBeenCalledTimes(1);
    f.gap();
    const late = new FakeSocket({ address: '127.0.0.1', family: 4, port: 43210 });
    resolve({ socket: late, outcome: 'connected' });
    await turns();
    expect(client.writes, 'LOCAL_GAP_PUBLISHED_CONNECT').toEqual([]);
    expect(late.writes).toEqual([]);
    expect(late.observedClosed).toBe(true);
    expect(() => broker.grantLocal('https://127.0.0.1:43210', 'opaque-connect', 10000)).toThrow(
      'AUTHORITY_REFUSED'
    );
    expect(f.issuer.snapshot(run).state).toBe('active');
  } finally {
    await broker.close();
  }
});
it('known public policy remains usable while only local coverage is incomplete', async () => {
  const f = issuerFixture(),
    run = await f.issuer.retainRun(binding),
    g = fakeTransport();
  f.gap();
  const broker = createPrivateBroker({
    issuer: f.issuer,
    run,
    policy: {
      revision: 1,
      adminAuthorities: [],
      hostInterfaces: [],
      privateAdminEndpoints: [],
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    },
    transport: g.transport,
  });
  try {
    const descriptor = await broker.start(),
      client = new FakeSocket();
    g.accept(client, {
      raw: {
        method: 'CONNECT',
        target: 'example.test:443',
        head: new Uint8Array(),
        rawHeaders: [
          'Host',
          'example.test:443',
          'Proxy-Authorization',
          'Bearer ' + descriptor.credential,
        ],
      },
      body: new (await import('./fake-transport.js')).FakeBody(),
    });
    await turns();
    client.emit('public-challenge');
    expect(g.origins[0]!.writes).toEqual(['public-challenge']);
  } finally {
    await broker.close();
  }
});
it('new policy revision cannot forgive quarantined same-browser circuit charges', async () => {
  const f = await fixture({ browserCircuits: 1 }),
    g = fakeTransport(),
    a = new FakeSocket();
  a.closeHeld = true;
  f.fake.accept(a, f.request());
  await turns();
  f.broker.suspend();
  f.setRevision(2);
  const run = await f.issuer.retainRun(binding),
    second = createPrivateBroker({
      issuer: f.issuer,
      run,
      policy: f.policyOptions(),
      transport: g.transport,
    });
  try {
    const descriptor = await second.start(),
      request = f.request();
    request.raw.rawHeaders[3] = 'Bearer ' + descriptor.credential;
    g.accept(new FakeSocket(), request);
    await turns();
    expect(g.transport.dial, 'POLICY_REVISION_FORGAVE_BROWSER_QUOTA').not.toHaveBeenCalled();
    expect(f.issuer.ledger.snapshot().circuits).toBe(1);
  } finally {
    a.closed();
    await turns();
    await second.close();
  }
});
