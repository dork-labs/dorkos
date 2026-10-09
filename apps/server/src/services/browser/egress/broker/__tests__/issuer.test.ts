import { describe, it, expect, vi } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
import { brokerLimits } from '../limits.js';
import { createLedger } from '../ledger.js';
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
  it('retains an ignored-abort authority slot until actual settlement', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let resolve!: (v: Awaited<ReturnType<typeof f.ports.readAuthority>>) => void;
      f.ports.readAuthority.mockImplementation(() => new Promise((done) => (resolve = done)));
      const opening = f.issuer.retainRun(binding);
      const rejected = expect(opening).rejects.toMatchObject({ code: 'AUTHORITY_REFUSED' });
      await vi.advanceTimersByTimeAsync(2000);
      await rejected;
      expect(f.issuer.ledger.snapshot().permits).toBe(1);
      resolve({
        binding,
        ownerExists: true,
        retainedRun: true,
        grantsCurrent: true,
        custodyKnown: true,
        runtimePolicyKnown: true,
        runtimeIdentity: 'fixture-runtime',
        authorizationEpoch: 1,
        policyRevision: 1,
        inventoryRevision: 1,
        monotonicNow: 0,
        utcNow: 1000,
        utcExpiresAt: 2000,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.issuer.ledger.snapshot().charged).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('retains charges across transfer, pending callback and unobserved socket closure', () => {
    const ledger = createLedger(brokerLimits({ globalCircuits: 1, browserCircuits: 1 }));
    const browser = {},
      charge = ledger.reserve('unauthenticated');
    const settled = ledger.pending(charge),
      closed = ledger.socket(charge, {});
    ledger.transfer(charge, browser);
    expect(ledger.release(charge)).toBe(false);
    expect(() => ledger.reserve('circuit', {})).toThrow('QUOTA');
    settled();
    expect(ledger.release(charge)).toBe(false);
    closed();
    expect(ledger.release(charge)).toBe(true);
    expect(ledger.release(charge)).toBe(false);
    expect(ledger.reserve('circuit', browser)).toBeDefined();
  });
  it('permanent invalid clock cannot reopen authority after finite recovery', async () => {
    const f = fixture(),
      run = await f.issuer.retainRun(binding);
    f.setTime(NaN);
    expect(() => f.issuer.check(run)).toThrow('CLOCK_UNVERIFIED');
    f.setTime(1);
    expect(() => f.issuer.check(run)).toThrow('CLOCK_UNVERIFIED');
    expect(f.issuer.snapshot(run).state).toBe('suspended');
  });
});
it('one outstanding renewal includes an issued unconsumed permit', async () => {
  const f = fixture(),
    run = await f.issuer.retainRun(binding, 10000);
  const p = await f.issuer.continuation(run, 0, 10000);
  await expect(f.issuer.continuation(run, 0, 10000)).rejects.toMatchObject({
    code: 'PERMIT_REFUSED',
  });
  f.issuer.consume(run, 0, p);
  const next = await f.issuer.continuation(run, 1, 10000);
  f.issuer.consume(run, 1, next);
  expect(f.issuer.snapshot(run).sequence).toBe(2);
});
it('suspension requires fresh revision permit and every owned circuit closure', async () => {
  const f = fixture(),
    run = await f.issuer.retainRun(binding, 10000);
  const oldDeadline = f.issuer.snapshot(run).deadline;
  const charge = f.issuer.ledger.reserve('circuit', run),
    closed = f.issuer.ledger.socket(charge, {});
  f.issuer.suspend(run);
  f.ports.readInventory.mockReturnValue({ ...f.ports.readInventory(), revision: 2 });
  const current = { ...f.ports.readCurrent(binding), policyRevision: 2, inventoryRevision: 2 };
  f.ports.readCurrent.mockReturnValue(current);
  f.ports.readAuthority.mockResolvedValue(current);
  const permit = await f.issuer.revisionPermit(run, 0);
  expect(() => f.issuer.consumeRevision(run, 0, permit, 2)).toThrow('PERMIT_REFUSED');
  closed();
  f.issuer.ledger.release(charge);
  f.issuer.consumeRevision(run, 0, permit, 2);
  expect(f.issuer.snapshot(run)).toMatchObject({
    state: 'active',
    policyRevision: 2,
    inventoryRevision: 2,
    sequence: 1,
    deadline: oldDeadline,
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
it('unknown current authority tombstones forwarding before a credential can help', async () => {
  const f = fixture(),
    run = await f.issuer.retainRun(binding);
  f.invalidate();
  expect(() => f.issuer.check(run)).toThrow('AUTHORITY_REFUSED');
  expect(f.issuer.snapshot(run).state).toBe('terminal');
});
it('known expired unconsumed permit can be retired without restarting its principal', async () => {
  const f = fixture(),
    run = await f.issuer.retainRun(binding, 20000);
  const old = await f.issuer.continuation(run, 0, 20000);
  f.setTime(5000);
  const next = await f.issuer.continuation(run, 0, 20000);
  expect(() => f.issuer.consume(run, 0, old)).toThrow('PERMIT_REFUSED');
  f.issuer.consume(run, 0, next);
  expect(f.issuer.snapshot(run).sequence).toBe(1);
});
it('a later wall-clock expiry cannot extend the original monotonic lease without renewal', async () => {
  const f = fixture(),
    run = await f.issuer.retainRun(binding, 10000);
  const deadline = f.issuer.snapshot(run).deadline;
  f.setUtc(0);
  f.setTime(1);
  f.issuer.check(run);
  expect(f.issuer.snapshot(run).deadline).toBe(deadline);
  f.setTime(10000);
  expect(() => f.issuer.check(run)).toThrow('EXPIRED');
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

it('one-use continuation cannot commit twice through the final clock callback', async () => {
  const f = issuerFixture(),
    run = await f.issuer.retainRun(reentrantBinding, 10000),
    permit = await f.issuer.continuation(run, 0, 10000);
  let n = 0,
    reentered = false;
  f.hook(() => {
    if (++n === 5) {
      reentered = true;
      f.hook();
      f.issuer.consume(run, 0, permit);
    }
  });
  try {
    f.issuer.consume(run, 0, permit);
  } catch {}
  expect(reentered, 'REENTRANT_CONSUME_REACHED').toBe(true);
  expect(f.issuer.snapshot(run).sequence, 'ONE_PERMIT_COMMITTED_TWICE').toBe(1);
  f.issuer.releaseRun(run);
});
it('revision consume rechecks opaque permit and sequence after every clock reentry', async () => {
  let reached = 0;
  for (let point = 1; point <= 6; point++) {
    const f = issuerFixture(),
      run = await f.issuer.retainRun(reentrantBinding, 10000);
    f.issuer.suspend(run);
    const p = await f.issuer.revisionPermit(run, 0);
    let calls = 0;
    f.hook(() => {
      if (++calls === point) {
        reached++;
        f.hook();
        try {
          f.issuer.consumeRevision(run, 0, p, 1);
        } catch {}
        f.issuer.suspend(run);
      }
    });
    try {
      f.issuer.consumeRevision(run, 0, p, 1);
    } catch {}
    expect(f.issuer.snapshot(run).sequence, 'REVISION_PERMIT_COMMITTED_TWICE').toBeLessThanOrEqual(
      1
    );
    f.hook();
    f.issuer.releaseRun(run);
  }
  expect(reached).toBeGreaterThan(0);
});
it.each(['continuation', 'revision'] as const)(
  'revocation during %s permit construction cannot publish a permit',
  async (kind) => {
    let revoked = false;
    for (let point = 1; point <= 12; point++) {
      const f = issuerFixture(),
        run = await f.issuer.retainRun(reentrantBinding, 10000);
      if (kind === 'revision') f.issuer.suspend(run);
      let calls = 0,
        hit = false;
      f.hook(() => {
        if (++calls === point) {
          hit = true;
          revoked = true;
          f.hook();
          f.issuer.revoke(run);
        }
      });
      let permit;
      try {
        permit = await (kind === 'revision'
          ? f.issuer.revisionPermit(run, 0)
          : f.issuer.continuation(run, 0, 10000));
      } catch {}
      f.hook();
      if (hit) {
        expect(permit, 'REVOKED_CONSTRUCTION_PUBLISHED_PERMIT').toBeUndefined();
        expect(f.issuer.ledger.snapshot().permits).toBe(0);
      } else {
        expect(permit).toBeDefined();
        expect(f.issuer.ledger.snapshot().permits).toBe(1);
      }
      f.issuer.releaseRun(run);
    }
    expect(revoked).toBe(true);
  }
);
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

it.each([undefined, false, new Error('inventory producer')])(
  'inventory failure %s invalidates outstanding authority before retaining its original cause',
  async (value) => {
    const f = fixture();
    const run = await f.issuer.retainRun(binding, 10000);
    const permit = await f.issuer.continuation(run, 0, 10000);
    const before = f.issuer.snapshot(run);
    const invalidated = vi.fn(() => {
      expect(f.issuer.snapshot(run).state).toBe('suspended');
      expect(f.issuer.ledger.snapshot().permits).toBe(0);
    });
    f.issuer.onInvalidation(run, invalidated);
    f.ports.readInventory.mockImplementationOnce(() => {
      throw value;
    });
    let caught: { value: unknown } | undefined;
    try {
      f.issuer.check(run);
    } catch (reason) {
      caught = { value: reason };
    }
    expect(caught).toEqual({ value });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(f.issuer.snapshot(run)).toMatchObject({
      state: 'suspended',
      sequence: before.sequence,
      deadline: before.deadline,
    });
    expect(() => f.issuer.consume(run, 0, permit)).toThrow('CLOSED');
    await expect(f.issuer.current(run)).rejects.toThrow('CLOSED');
    await expect(f.issuer.continuation(run, 0)).rejects.toThrow('CLOSED');
  }
);
