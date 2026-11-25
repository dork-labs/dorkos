import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import * as os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createServerInventory } from '../server-inventory.js';
import { createEgressPolicy } from '../../policy.js';
import { inventorySnapshot } from '../observations.js';
import { createBrokerIssuer } from '../issuer.js';
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
