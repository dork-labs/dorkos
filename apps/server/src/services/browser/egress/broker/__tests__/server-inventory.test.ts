import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import * as os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createServerInventory } from '../server-inventory.js';
import { createEgressPolicy } from '../../policy.js';
import { inventorySnapshot } from '../observations.js';
import { createBrokerIssuer } from '../issuer.js';
import { brokerLocalGrants } from '../local-grants.js';
import { createPrivateBroker } from '../broker.js';
import { FakeBody, FakeSocket, fakeTransport } from './fake-transport.js';
import { turns } from './broker-fixture.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});

const originals = new Set<Server>();
afterEach(async () => {
  vi.mocked(os.networkInterfaces).mockReset();
  vi.mocked(os.networkInterfaces).mockImplementation(
    (await vi.importActual<typeof import('node:os')>('node:os')).networkInterfaces
  );
  await Promise.all(
    [...originals].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  originals.clear();
});
const original = () => {
  const server = createServer();
  originals.add(server);
  return server;
};
const inventory = (instances = [{ id: 'main', listeners: ['http'] }]) =>
  createServerInventory({
    instances,
    adminAuthorities: ['http://admin.example'],
    now: () => 0,
  });
async function listen(
  adapter: ReturnType<typeof inventory>,
  host = '127.0.0.1',
  instance = 'main',
  listener = 'http'
) {
  const server = adapter.acquire(instance, listener, original, (server) => server.listen(0, host));
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native bound address');
  return { server, port: address.port };
}

it('protects the actual ephemeral main port while preserving the original server', async () => {
  const adapter = inventory();
  expect(adapter.readInventory().localCoverageComplete).toBe(false);
  const { server, port } = await listen(adapter);
  const snapshot = adapter.observe();
  expect(snapshot.inventory.localCoverageComplete).toBe(true);
  expect(inventorySnapshot(snapshot.inventory, 0).protectedEndpoints).toEqual([
    { address: '127.0.0.1', port },
  ]);
  expect(server.listening).toBe(true);
  expect(snapshot.policyInputs!.hostInterfaces).not.toContain('127.0.0.1');
  expect(snapshot.policyInputs!.hostInterfaces).not.toContain('::1');
  const policy = createEgressPolicy({
    revision: 1,
    ...snapshot.policyInputs!,
    resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    now: () => 0,
  });
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  expect(() => policy.issueLocalGrant(binding, `http://127.0.0.1:${port}`, 100)).toThrow(
    'ADMIN_DENIED'
  );
  expect(() => policy.issueLocalGrant(binding, 'http://admin.example', 100)).toThrow(
    'ADMIN_DENIED'
  );
  const control = original();
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const controlAddress = control.address();
  if (!controlAddress || typeof controlAddress === 'string')
    throw new Error('Missing control address');
  expect(() =>
    policy.issueLocalGrant(binding, `http://127.0.0.1:${controlAddress.port}`, 100)
  ).not.toThrow();
});

it('does not confuse one bound listener with complete declared-instance coverage', async () => {
  const adapter = inventory([
    { id: 'main', listeners: ['http', 'preview'] },
    { id: 'desktop', listeners: ['http'] },
  ]);
  await listen(adapter);
  expect(adapter.readInventory().coveredInstances).toEqual([]);
  await listen(adapter, '127.0.0.1', 'main', 'preview');
  expect(adapter.readInventory().coveredInstances).toEqual(['main']);
  expect(adapter.readInventory().localCoverageComplete).toBe(false);
  await listen(adapter, '127.0.0.1', 'desktop');
  expect(adapter.readInventory().localCoverageComplete).toBe(true);
});

it('protects canonical IPv4 access to a real wildcard listener', async () => {
  const adapter = inventory();
  const { port } = await listen(adapter, '0.0.0.0');
  expect(adapter.readInventory().protectedEndpoints).toEqual([{ address: '127.0.0.1', port }]);
});

it('protects the actual canonical IPv6 listener port', async () => {
  const adapter = inventory();
  const { port } = await listen(adapter, '::1');
  expect(adapter.readInventory().protectedEndpoints).toEqual([{ address: '::1', port }]);
  expect(adapter.readInventory().localCoverageComplete).toBe(true);
});

it('conservatively protects both canonical families for an actual IPv6 wildcard bind', async () => {
  const adapter = inventory();
  const { port } = await listen(adapter, '::');
  expect(adapter.readInventory().protectedEndpoints).toEqual([
    { address: '::1', port },
    { address: '127.0.0.1', port },
  ]);
});

it('fails permanently after the trusted inventory clock regresses', () => {
  let now = 10;
  const adapter = createServerInventory({
    instances: [{ id: 'main', listeners: ['http'] }],
    adminAuthorities: [],
    now: () => now,
  });
  adapter.observe();
  now = 9;
  expect(() => adapter.observe()).toThrow('CLOCK_UNVERIFIED');
  now = 11;
  expect(() => adapter.observe()).toThrow('CLOCK_UNVERIFIED');
});

it('composes native inventory with canonical-only grants and preserves a known run on listener coverage loss', async () => {
  const adapter = inventory();
  const { server, port } = await listen(adapter);
  const snapshot = adapter.observe();
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: true as const,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'native-fixture',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: snapshot.inventory.revision,
    monotonicNow: 0,
    utcNow: 1000,
    utcExpiresAt: 2000,
  });
  const issuer = createBrokerIssuer({
    now: () => 0,
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: adapter.readInventory,
    },
  });
  const run = await issuer.retainRun(binding);
  const policy = createEgressPolicy({
    revision: 1,
    ...snapshot.policyInputs!,
    now: () => 0,
    resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
  });
  const grants = brokerLocalGrants(issuer, run, policy);
  try {
    expect(() => grants.issue(`http://127.0.0.1:${port}`, 'http', 100)).toThrow(
      'AUTHORITY_REFUSED'
    );
    expect(() => grants.issue('http://127.0.0.2:33333', 'http', 100)).toThrow('AUTHORITY_REFUSED');
    grants.issue('http://127.0.0.1:33333', 'http', 100);
    expect(grants.get('http://127.0.0.1:33333', 'http')).toBeDefined();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    expect(issuer.check(run).state).toBe('active');
    expect(() => grants.check(snapshot.inventory.revision)).toThrow('AUTHORITY_REFUSED');
    expect(issuer.snapshot(run).state).toBe('active');
    expect(grants.get('http://127.0.0.1:33333', 'http')).toBeUndefined();
  } finally {
    grants.revoke();
    issuer.releaseRun(run);
  }
});

it('retains security revision and protected denies after the original listener closes', async () => {
  const adapter = inventory();
  const { server } = await listen(adapter);
  const before = adapter.readInventory();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  const after = adapter.readInventory();
  expect(after.localCoverageComplete).toBe(false);
  expect(after.revision).toBe(before.revision);
  expect(after.protectedEndpoints).toEqual(before.protectedEndpoints);
  const blockOldPort = original();
  blockOldPort.listen(before.protectedEndpoints[0]!.port, '127.0.0.1');
  await once(blockOldPort, 'listening');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  expect(adapter.readInventory().localCoverageComplete).toBe(false);
  expect(adapter.readInventory().protectedEndpoints).toHaveLength(2);
  expect(adapter.readInventory().revision).toBeGreaterThan(before.revision);
});

it('retains a listening original when acquisition throws and refuses a replacement', async () => {
  const adapter = inventory();
  const server = original();
  expect(() =>
    adapter.acquire(
      'main',
      'http',
      () => server,
      (retained) => {
        expect(retained).toBe(server);
        retained.listen(0, '127.0.0.1');
        throw new Error('Registration failed after listen');
      }
    )
  ).toThrow('Registration failed');
  await once(server, 'listening');
  expect(adapter.readInventory().localCoverageComplete).toBe(false);
  expect(adapter.readInventory().protectedEndpoints).toHaveLength(1);
  expect(server.listening).toBe(true);
  expect(() => adapter.acquire('main', 'http', original, () => {})).toThrow('occupied');
});

it('reserves a failed factory before any second acquisition can fabricate coverage', () => {
  const adapter = inventory();
  expect(() =>
    adapter.acquire(
      'main',
      'http',
      () => {
        throw new Error('Lost factory');
      },
      () => {}
    )
  ).toThrow('Lost factory');
  expect(() => adapter.acquire('main', 'http', original, () => {})).toThrow('occupied');
  expect(adapter.readInventory().localCoverageComplete).toBe(false);
});

it('closes local admission on an interface gap while retaining observed interface denies and exact admin policy', async () => {
  const adapter = inventory();
  await listen(adapter);
  const before = adapter.observe();
  const expected = [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .map((entry) => entry.address)
        .filter((address) => address !== '127.0.0.1' && address !== '::1')
    ),
  ].sort();
  expect(before.policyInputs!.hostInterfaces).toEqual(expected);
  vi.mocked(os.networkInterfaces).mockImplementation(() => {
    throw new Error('Native interface read failed');
  });
  const after = adapter.observe();
  expect(after.interfacesKnown).toBe(false);
  expect(after.inventory.localCoverageComplete).toBe(false);
  expect(after.inventory.publicAuthoritiesKnown).toBe(true);
  expect(after.inventory.revision).toBe(before.inventory.revision);
  expect(after.inventory.protectedEndpoints).toEqual(before.inventory.protectedEndpoints);
  expect(after.policyInputs!.hostInterfaces).toEqual(before.policyInputs!.hostInterfaces);
  expect(after.policyInputs!.adminAuthorities).toEqual(['http://admin.example']);
});

it('does not invent usable interface policy on initial acquisition failure', () => {
  vi.mocked(os.networkInterfaces).mockReturnValue({});
  const snapshot = inventory().observe();
  expect(snapshot.inventory.localCoverageComplete).toBe(false);
  expect(snapshot.interfacesKnown).toBe(false);
  expect(snapshot.policyInputs).toBeNull();
});

async function composedBroker(adapter: ReturnType<typeof inventory>) {
  const snapshot = adapter.observe();
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: true as const,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'native-inventory-fixture',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: snapshot.inventory.revision,
    monotonicNow: 0,
    utcNow: 1000,
    utcExpiresAt: 2000,
  });
  const issuer = createBrokerIssuer({
    now: () => 0,
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: adapter.readInventory,
    },
  });
  const run = await issuer.retainRun(binding);
  const fake = fakeTransport();
  const broker = createPrivateBroker({
    issuer,
    run,
    transport: fake.transport,
    policy: {
      revision: 1,
      ...snapshot.policyInputs!,
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    },
  });
  const descriptor = await broker.start();
  const connect = async (target: string) => {
    const client = new FakeSocket();
    expect(
      fake.accept(client, {
        raw: {
          method: 'CONNECT',
          target,
          head: new Uint8Array(),
          rawHeaders: ['Host', target, 'Proxy-Authorization', `Bearer ${descriptor.credential}`],
        },
        body: new FakeBody(),
      })
    ).toBe(true);
    await turns();
    expect(client.writes.join('')).toContain('200 Connection Established');
    return client;
  };
  return { issuer, run, broker, fake, connect, snapshot };
}

it.each(['listener', 'interfaces'] as const)(
  'a native %s coverage gap closes only local circuits and retains public traffic',
  async (gap) => {
    const adapter = inventory();
    const { server } = await listen(adapter);
    const control = original();
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    const controlAddress = control.address();
    if (!controlAddress || typeof controlAddress === 'string')
      throw new Error('Missing control address');
    const f = await composedBroker(adapter);
    try {
      f.broker.grantLocal(`https://127.0.0.1:${controlAddress.port}`, 'opaque-connect', 500);
      const local = await f.connect(`127.0.0.1:${controlAddress.port}`);
      const publicClient = await f.connect('example.test:443');
      expect(f.fake.origins).toHaveLength(2);
      const [localOrigin, publicOrigin] = f.fake.origins;
      if (gap === 'listener')
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      else
        vi.mocked(os.networkInterfaces).mockImplementation(() => {
          throw new Error('Interface coverage lost');
        });
      const after = adapter.observe();
      expect(after.inventory.localCoverageComplete).toBe(false);
      expect(after.inventory.revision).toBe(f.snapshot.inventory.revision);
      expect(after.inventory.protectedEndpoints).toEqual(f.snapshot.inventory.protectedEndpoints);
      expect(after.policyInputs).toEqual(f.snapshot.policyInputs);
      expect(f.issuer.check(f.run).state).toBe('active');
      publicClient.emit('public-survives');
      await turns();
      expect(publicOrigin!.writes).toEqual(['public-survives']);
      expect(publicClient.observedClosed).toBe(false);
      expect(local.observedClosed).toBe(true);
      expect(localOrigin!.observedClosed).toBe(true);
      local.emit('local-refused');
      expect(localOrigin!.writes).toEqual([]);
      expect(() =>
        f.broker.grantLocal(`https://127.0.0.1:${controlAddress.port}`, 'opaque-connect', 500)
      ).toThrow('AUTHORITY_REFUSED');
      expect(f.issuer.check(f.run).state).toBe('active');
      expect(f.issuer.ledger.snapshot().circuits).toBe(1);
    } finally {
      await f.broker.close();
    }
  }
);

it('keeps a public circuit through missing declared coverage, then suspends it for a newly observed native protected endpoint', async () => {
  const adapter = inventory([
    { id: 'main', listeners: ['http'] },
    { id: 'desktop', listeners: ['http'] },
  ]);
  await listen(adapter);
  const f = await composedBroker(adapter);
  try {
    expect(f.snapshot.inventory.localCoverageComplete).toBe(false);
    expect(f.snapshot.inventory.coveredInstances).toEqual(['main']);
    const client = await f.connect('example.test:443');
    const origin = f.fake.origins[0]!;
    client.emit('known-public');
    expect(origin.writes).toEqual(['known-public']);
    await listen(adapter, '127.0.0.1', 'desktop');
    const next = adapter.observe();
    expect(next.inventory.localCoverageComplete).toBe(true);
    expect(next.inventory.revision).toBeGreaterThan(f.snapshot.inventory.revision);
    expect(next.inventory.protectedEndpoints).toHaveLength(2);
    client.emit('new-deny-requires-rebind');
    await turns();
    expect(origin.writes).toEqual(['known-public']);
    expect(client.observedClosed).toBe(true);
    expect(origin.observedClosed).toBe(true);
    expect(f.issuer.snapshot(f.run).state).toBe('suspended');
  } finally {
    await f.broker.close();
  }
});

it('requires a new security revision when an OS census reports an additional interface deny', async () => {
  const adapter = inventory();
  await listen(adapter);
  const f = await composedBroker(adapter);
  try {
    const client = await f.connect('example.test:443');
    const origin = f.fake.origins[0]!;
    const census = os.networkInterfaces();
    // A fault-controlled OS observation exercises a policy change. Actual listener
    // endpoint changes and the baseline census are covered by native controls above.
    vi.mocked(os.networkInterfaces).mockReturnValue({
      ...census,
      changed: [
        {
          address: '198.18.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '198.18.0.1/16',
        },
      ],
    });
    const next = adapter.observe();
    expect(next.inventory.localCoverageComplete).toBe(true);
    expect(next.policyInputs!.hostInterfaces).toContain('198.18.0.1');
    expect(next.inventory.revision).toBeGreaterThan(f.snapshot.inventory.revision);
    client.emit('new-interface-requires-rebind');
    await turns();
    expect(origin.writes).toEqual([]);
    expect(client.observedClosed).toBe(true);
    expect(origin.observedClosed).toBe(true);
    expect(f.issuer.snapshot(f.run).state).toBe('suspended');
  } finally {
    await f.broker.close();
  }
});

it.each(['census', 'listener'] as const)(
  'globally refuses a new %s deny when the permanent interface bank is full',
  async (mode) => {
    // Fault-controlled capacity observations only: this control acquires no native
    // listener and makes no native coverage claim. The broker transport is a fixture.
    const entries = Array.from({ length: 256 }, (_, n) => ({
      address: `198.18.0.${n}`,
      netmask: '255.255.0.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: `198.18.0.${n}/16`,
    }));
    vi.mocked(os.networkInterfaces).mockReturnValue({ capacityFixture: entries });
    const adapter = inventory([
      { id: 'main', listeners: ['http'] },
      { id: 'desktop', listeners: ['http'] },
    ]);
    const restores: (() => void)[] = [];
    const observeListener = (instance: string, address: string, port: number) => {
      const server = createServer();
      const listening = vi.spyOn(server, 'listening', 'get').mockReturnValue(true);
      const bound = vi.spyOn(server, 'address').mockReturnValue({ address, family: 'IPv4', port });
      restores.push(() => {
        listening.mockRestore();
        bound.mockRestore();
      });
      adapter.acquire(
        instance,
        'http',
        () => server,
        (retained) => {
          retained.emit('listening');
        }
      );
    };
    observeListener('main', '127.0.0.1', 4242);
    const f = await composedBroker(adapter);
    try {
      expect(f.snapshot.policyInputs!.hostInterfaces).toHaveLength(256);
      const client = await f.connect('example.test:443');
      const origin = f.fake.origins[0]!;
      if (mode === 'census')
        vi.mocked(os.networkInterfaces).mockReturnValue({
          capacityFixture: [
            ...entries,
            {
              ...entries[0]!,
              address: '198.18.1.1',
              cidr: '198.18.1.1/16',
            },
          ],
        });
      else observeListener('desktop', '127.0.0.2', 4243);
      client.emit('unrecorded-new-deny-must-refuse');
      await turns();
      expect(origin.writes).toEqual([]);
      expect(() => adapter.observe()).toThrow('Interface inventory exhausted');
      expect(client.observedClosed).toBe(true);
      expect(origin.observedClosed).toBe(true);
      expect(f.issuer.snapshot(f.run).state).toBe('suspended');
      vi.mocked(os.networkInterfaces).mockReturnValue({ capacityFixture: entries });
      for (const restore of restores.splice(0)) restore();
      expect(() => adapter.observe()).toThrow('Interface inventory exhausted');
    } finally {
      await f.broker.close();
      for (const restore of restores) restore();
    }
  }
);
