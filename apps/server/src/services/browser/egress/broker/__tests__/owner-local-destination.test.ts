import { expect, it, onTestFinished } from 'vitest';
import { createBrokerIssuer } from '../issuer.js';
import { inventorySnapshot } from '../observations.js';
import { brokerLocalGrants } from '../local-grants.js';
import { createEgressPolicy } from '../../policy.js';

/** Original issuer and policy; no HTTP/native permission is inferred from this portable control. */
async function localFixture() {
  const state = {
    now: 0,
    inventoryFailure: undefined as undefined | { value: unknown },
  };
  const binding = {
    ownerId: 'owner',
    workspaceId: 'workspace',
    browserId: 'browser',
    browserGeneration: 1,
  };
  const actualInventory = () => {
    if (state.inventoryFailure) throw state.inventoryFailure.value;
    return inventorySnapshot(
      {
        revision: 1,
        publicAuthoritiesKnown: true,
        localCoverageComplete: true,
        validUntil: 1000000,
        protectedEndpoints: [{ address: '127.0.0.1', port: 4242 }],
        declaredInstances: ['main'],
        coveredInstances: ['main'],
      },
      state.now
    );
  };
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
    monotonicNow: state.now,
    utcNow: 1000 + state.now,
    utcExpiresAt: 1000000,
  });
  const issuer = createBrokerIssuer({
    now: () => state.now,
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: actualInventory,
    },
  });
  const starting = Promise.resolve().then(() => issuer.retainRun(binding));
  const retained: { local?: ReturnType<typeof brokerLocalGrants> } = {};
  let finishing: Promise<void> | undefined;
  const finish = () =>
    (finishing ??= Promise.resolve().then(async () => {
      const run = await starting;
      let first: { value: unknown } | undefined;
      try {
        retained.local?.revoke();
      } catch (value) {
        first ??= { value };
      }
      try {
        issuer.releaseRun(run);
      } catch (value) {
        first ??= { value };
      }
      if (first) throw first.value;
    }));
  onTestFinished(finish);
  const run = await starting;
  const policy = createEgressPolicy({
    revision: 1,
    adminAuthorities: [],
    privateAdminEndpoints: [{ address: '127.0.0.1', port: 4242 }],
    hostInterfaces: [],
    resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    now: () => state.now,
  });
  const local = (retained.local = brokerLocalGrants(issuer, run, policy));
  return { state, local, issuer, run };
}

it('an exact local HTTP permission expires and permanently protected endpoints never issue a permit', async () => {
  const f = await localFixture();
  const denials: unknown[] = [];
  expect(() =>
    f.local.issue('http://127.0.0.1:4242/', 'http', 500, (value) => denials.push(value))
  ).toThrow('AUTHORITY_REFUSED');
  expect(denials).toHaveLength(1);
  expect(f.issuer.ledger.snapshot().permits).toBe(0);
  f.local.issue('http://127.0.0.1:4243/', 'http', 500, (value) => denials.push(value));
  expect(f.local.get('http://127.0.0.1:4243/page', 'http')).toBeDefined();
  expect(f.local.get('http://127.0.0.1:4244/', 'http')).toBeUndefined();
  f.state.now = 500;
  expect(() => f.local.get('http://127.0.0.1:4243/', 'http')).toThrow('EXPIRED');
});

it.each([undefined, false, new Error('original inventory')])(
  'original inventory failure %s never receives local denial provenance',
  async (value) => {
    const f = await localFixture(),
      denials: unknown[] = [];
    f.state.inventoryFailure = { value };
    let caught: { value: unknown } | undefined;
    try {
      f.local.issue('http://127.0.0.1:4243/', 'http', 500, (original) => denials.push(original));
    } catch (reason) {
      caught = { value: reason };
    }
    expect(caught).toEqual({ value });
    expect(denials).toEqual([]);
    expect(f.issuer.snapshot(f.run).state).toBe('suspended');
    expect(f.issuer.ledger.snapshot().permits).toBe(0);
    f.state.inventoryFailure = undefined;
    expect(() => f.issuer.check(f.run)).toThrow('CLOSED');
  }
);
