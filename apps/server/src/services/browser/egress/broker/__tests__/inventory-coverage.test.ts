import { expect, it } from 'vitest';
import { inventorySnapshot } from '../observations.js';
import { createBrokerIssuer } from '../issuer.js';
import { brokerLocalGrants } from '../local-grants.js';
import { createEgressPolicy } from '../../policy.js';

const partial = {
  revision: 1,
  publicAuthoritiesKnown: true,
  localCoverageComplete: false,
  validUntil: 1000,
  protectedEndpoints: [{ address: '127.0.0.1', port: 4242 }],
  declaredInstances: ['main', 'desktop'],
  coveredInstances: ['main'],
};

it('retains an explicit local coverage gap without discarding known public policy', () => {
  const observation = inventorySnapshot(partial, 0);
  expect(observation.localCoverageComplete).toBe(false);
  expect(observation.declaredInstances).toEqual(['main', 'desktop']);
  expect(observation.coveredInstances).toEqual(['main']);
  expect(observation.protectedEndpoints).toEqual(partial.protectedEndpoints);
});

it('refuses falsely complete, stale, or unknown public authority observations', () => {
  for (const observation of [
    { ...partial, localCoverageComplete: true },
    { ...partial, validUntil: 0 },
    { ...partial, publicAuthoritiesKnown: false },
  ]) {
    expect(() => inventorySnapshot(observation, 0)).toThrow('AUTHORITY_REFUSED');
  }
});

it('keeps a known run checked but refuses local grants when a declared instance is uncovered', async () => {
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
    runtimeIdentity: 'fixture',
    authorizationEpoch: 1,
    policyRevision: 1,
    inventoryRevision: 1,
    monotonicNow: 0,
    utcNow: 1000,
    utcExpiresAt: 2000,
  });
  const issuer = createBrokerIssuer({
    now: () => 0,
    ports: {
      readCurrent: authority,
      readAuthority: async () => authority(),
      readInventory: () => inventorySnapshot(partial, 0),
    },
  });
  const run = await issuer.retainRun(binding);
  try {
    expect(issuer.check(run).state).toBe('active');
    const policy = createEgressPolicy({
      revision: 1,
      adminAuthorities: [],
      privateAdminEndpoints: partial.protectedEndpoints,
      hostInterfaces: [],
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
      now: () => 0,
    });
    const local = brokerLocalGrants(issuer, run, policy);
    expect(() => local.issue('http://127.0.0.1:4243/', 'http', 500)).toThrow('AUTHORITY_REFUSED');
    expect(issuer.check(run).state).toBe('active');
    expect(issuer.ledger.snapshot().permits).toBe(0);
  } finally {
    issuer.releaseRun(run);
  }
});
