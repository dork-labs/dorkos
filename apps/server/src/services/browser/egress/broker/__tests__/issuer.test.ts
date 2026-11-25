import { describe, it, expect, vi } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
const binding = {
  ownerId: 'owner',
  workspaceId: 'workspace',
  browserId: 'browser',
  browserGeneration: 1,
};
function fixture() {
  let time = 0,
    utc = 1000;
  let valid = true;
  const authority = () => ({
    binding,
    ownerExists: true as const,
    retainedRun: true as const,
    grantsCurrent: true as const,
    custodyKnown: true as const,
    runtimePolicyKnown: true as const,
    runtimeIdentity: 'fixture-runtime',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    monotonicNow: time,
    utcNow: utc,
    utcExpiresAt: utc + 300000,
  });
  const ports = {
    readCurrent: vi.fn((_context = binding) => {
      if (!valid) throw Error('secret');
      return authority();
    }),
    readAuthority: vi.fn(async () => {
      if (!valid) throw Error('secret');
      return authority();
    }),
    readInventory: vi.fn(() => ({
      revision: 1,
      publicAuthoritiesKnown: true as const,
      localCoverageComplete: true,
      validUntil: 1000000,
      protectedEndpoints: [],
      declaredInstances: ['fixture'],
      coveredInstances: ['fixture'],
    })),
  };
  return {
    issuer: createBrokerIssuer({
      ports,
      now: () => time,
      limits: { leaseMs: 300000, renewalLeadMs: 300000 },
    }),
    ports,
    setTime: (n: number) => (time = n),
    setUtc: (n: number) => (utc = n),
    invalidate: () => (valid = false),
  };
}
describe('private issuer authority and continuous custody', () => {
  it('refuses missing retained-run producer without listener admission', async () => {
    const issuer = createBrokerIssuer({ now: () => 0 });
    await expect(issuer.retainRun(binding)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(issuer.ledger.snapshot().charged).toBe(0);
  });
  it('renews same run sequentially and consumes each opaque permit exactly once', async () => {
    const f = fixture(),
      run = await f.issuer.retainRun(binding, 10000);
    f.setTime(1000);
    const p = await f.issuer.continuation(run, 0, 10000);
    expect(() => f.issuer.consume(run, 0, { ...p })).toThrow('PERMIT_REFUSED');
    f.issuer.consume(run, 0, p);
    expect(f.issuer.snapshot(run).sequence).toBe(1);
    expect(() => f.issuer.consume(run, 0, p)).toThrow();
    const second = await f.issuer.continuation(run, 1, 10000);
    f.issuer.consume(run, 1, second);
    expect(f.issuer.snapshot(run).sequence).toBe(2);
  });
  it('cannot resurrect revoked or expired runs with delayed authority', async () => {
    const f = fixture(),
      run = await f.issuer.retainRun(binding, 10);
    f.setTime(10);
    await expect(f.issuer.continuation(run, 0)).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(f.issuer.snapshot(run).state).toBe('terminal');
    f.setTime(11);
    await expect(f.issuer.current(run)).rejects.toThrow();
  });
});
it('stale revision permit never authorizes changed runtime custody', async () => {
  const f = fixture(),
    run = await f.issuer.retainRun(binding);
  f.issuer.suspend(run);
  f.ports.readAuthority.mockResolvedValue({
    ...f.ports.readCurrent(binding),
    runtimeIdentity: 'other-runtime',
  });
  await expect(f.issuer.revisionPermit(run, 0)).rejects.toMatchObject({ code: 'PERMIT_REFUSED' });
  expect(f.issuer.snapshot(run).state).toBe('suspended');
});

const reentrantBinding = {
  ownerId: 'owner',
  workspaceId: 'workspace',
  browserId: 'browser',
  browserGeneration: 1,
};
function issuerFixture(limits?: Parameters<typeof createBrokerIssuer>[0]['limits']) {
  let tick = 0;
  let hook: (() => void) | undefined;
  let complete = true;
  const authority = (context = reentrantBinding) => ({
    binding: context,
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
    limits,
    now: () => {
      hook?.();
      return tick;
    },
    ports: {
      readCurrent: authority,
      readAuthority: async (context) => authority(context),
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
it.each(['ownerId', 'workspaceId', 'browserId', 'browserGeneration'] as const)(
  'browser quota distinguishes only genuine %s lifetime changes',
  async (field) => {
    const f = issuerFixture({ browserCircuits: 1, globalCircuits: 2 }),
      first = await f.issuer.retainRun(reentrantBinding);
    const changed = { ...reentrantBinding, [field]: field === 'browserGeneration' ? 2 : 'other' };
    const second = await f.issuer.retainRun(changed);
    const a = f.issuer.ledger.reserve('circuit', first),
      b = f.issuer.ledger.reserve('circuit', second);
    expect(f.issuer.ledger.snapshot().circuits).toBe(2);
    f.issuer.ledger.release(a);
    f.issuer.ledger.release(b);
    f.issuer.releaseRun(first);
    f.issuer.releaseRun(second);
  }
);
