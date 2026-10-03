import { vi, afterEach } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
import { createPrivateBroker } from '../broker.js';
import { FakeBody, fakeTransport } from './fake-transport.js';
const binding = {
  ownerId: 'owner',
  workspaceId: 'workspace',
  browserId: 'browser',
  browserGeneration: 1,
};
const cleanup = new Set<ReturnType<typeof createPrivateBroker>>();
export async function fixture(limits?: Parameters<typeof createBrokerIssuer>[0]['limits']) {
  let time = 0,
    revision = 1,
    valid = true;
  let clockObservation = () => {};
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: valid as true,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'fixture',
    authorizationEpoch: 1,
    policyRevision: revision,
    inventoryRevision: revision,
    monotonicNow: time,
    utcNow: 1000 + time,
    utcExpiresAt: 100000 + time,
  });
  const issuer = createBrokerIssuer({
    limits,
    now: () => {
      clockObservation();
      return time;
    },
    ports: {
      readCurrent: () => authority(),
      readAuthority: async () => authority(),
      readInventory: () => ({
        revision,
        publicAuthoritiesKnown: true,
        localCoverageComplete: true,
        validUntil: 100000,
        protectedEndpoints: [],
        declaredInstances: ['fixture'],
        coveredInstances: ['fixture'],
      }),
    },
  });
  const run = await issuer.retainRun(binding);
  const fake = fakeTransport();
  const resolver = vi.fn(async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }));
  const policyOptions = () => ({
    revision,
    adminAuthorities: ['http://admin.example'],
    hostInterfaces: [],
    privateAdminEndpoints: [],
    resolver,
  });
  const create = (transport = fake.transport) => {
    const b = createPrivateBroker({
      issuer,
      run,
      policy: policyOptions(),
      transport,
    });
    cleanup.add(b);
    return b;
  };
  const broker = create();
  cleanup.add(broker);
  const descriptor = await broker.start();
  const request = (kind = 'CONNECT', target = 'example.test:443', extra: string[] = []) => ({
    raw: {
      method: kind,
      target,
      head: new Uint8Array(),
      rawHeaders: [
        'Host',
        kind === 'CONNECT' ? target : 'example.test',
        'Proxy-Authorization',
        'Bearer ' + descriptor.credential,
        ...extra,
      ],
    },
    body: new FakeBody(),
  });
  return {
    issuer,
    run,
    fake,
    broker,
    resolver,
    descriptor,
    request,
    setTime: (n: number) => (time = n),
    observeClock: (observe: () => void) => (clockObservation = observe),
    invalidate: () => {
      valid = false;
    },
    setRevision: (n: number) => {
      revision = n;
    },
    policyOptions,
    create,
  };
}
export async function turns() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...cleanup].map((b) => b.close()));
  cleanup.clear();
});
