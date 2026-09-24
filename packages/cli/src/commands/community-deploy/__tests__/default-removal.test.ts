import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { createDefaultRemovalProbes } from '../runtime/default-removal.js';
import type { RemovalTarget } from '../provenance/uncertain-removal.js';

const mocks = vi.hoisted(() => ({
  readFlyApps: vi.fn(),
  destroyFlyApp: vi.fn(),
  unsetFlyTigrisSecrets: vi.fn(),
  readNeonProjects: vi.fn(),
  readNeonBranches: vi.fn(),
  readNeonBranchTopology: vi.fn(),
  deleteNeonProject: vi.fn(),
  readFlySecretInventory: vi.fn(),
  readAppProvenance: vi.fn(),
  readTigrisOnApp: vi.fn(),
  deleteTigris: vi.fn(),
  isAppNameAvailable: vi.fn(),
}));

vi.mock('../fly-read.js', () => ({ readFlyApps: mocks.readFlyApps }));
vi.mock('../fly-mutate.js', () => ({
  destroyFlyApp: mocks.destroyFlyApp,
  unsetFlyTigrisSecrets: mocks.unsetFlyTigrisSecrets,
}));
vi.mock('../neon-read.js', () => ({
  readNeonProjects: mocks.readNeonProjects,
  readNeonBranches: mocks.readNeonBranches,
  readNeonBranchTopology: mocks.readNeonBranchTopology,
}));
vi.mock('../neon-mutate.js', () => ({ deleteNeonProject: mocks.deleteNeonProject }));
vi.mock('../tigris-session.js', () => ({
  readFlySecretInventory: mocks.readFlySecretInventory,
  readFlySessionCredential: vi.fn(async () => ({
    use: async <T>(consumer: (token: string) => Promise<T>) => consumer('fixture-token'),
    dispose: vi.fn(),
  })),
}));
vi.mock('../fly-graphql-client.js', () => ({
  FlyGraphqlClientError: class extends Error {},
  FlyTigrisGraphqlClient: class {
    readAppProvenance = mocks.readAppProvenance;
    readTigrisOnApp = mocks.readTigrisOnApp;
    deleteTigris = mocks.deleteTigris;
    isAppNameAvailable = mocks.isAppNameAvailable;
  },
}));

const options = {
  fly: { executable: 'fly', env: {}, timeoutMs: 1_000 },
  neon: { executable: 'neonctl', env: {}, timeoutMs: 1_000 },
  graphqlTimeoutMs: 1_000,
};
const probes = createDefaultRemovalProbes(options);
const intent = {
  provider: 'fly' as const,
  organizationId: 'acme',
  resourceName: 'community-acme',
  provenanceMarker: '7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
  requestedAt: '2026-09-23T10:31:03.000Z',
};
const journal: LaunchJournal = LaunchJournalSchema.parse({
  schemaVersion: 1,
  runId: '3f2c9a1e-1111-4111-8111-111111111111',
  revision: 0,
  planHash: 'b'.repeat(64),
  releaseDigest: `sha256:${'a'.repeat(64)}`,
  recoveryContext: {
    version: '0.82.0',
    flyOrganization: 'acme',
    flyRegion: 'ord',
    appName: 'community-acme',
    machineSize: 'shared-cpu-1x',
    neonOrganization: 'org-acme',
    neonRegion: 'aws-us-east-2',
    neonProjectName: 'community-acme',
    bucketName: 'community-acme',
  },
  state: 'uncertain',
  pendingIntent: intent,
  resources: {},
  verifiedBindings: [],
  completedSteps: ['planned'],
  lastSafeError: null,
  createdAt: '2026-09-23T10:30:00.000Z',
  updatedAt: '2026-09-23T10:31:10.000Z',
});
const flyTarget: RemovalTarget = {
  provider: 'fly',
  token: '4817203',
  resourceName: 'community-acme',
  organization: 'acme',
  proof: 'marker',
  appName: 'community-acme',
};

function provenance(update: Record<string, unknown> = {}) {
  return {
    id: 'community-acme',
    internalNumericId: '4817203',
    name: 'community-acme',
    network: 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
    createdAt: '2026-09-23T10:31:07Z',
    organizationSlug: 'acme',
    machineCount: 0,
    volumeCount: 0,
    ipAddressCount: 0,
    certificateCount: 0,
    secretNames: [],
    ...update,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFlyApps.mockResolvedValue([]);
});

describe('Fly removal probe', () => {
  it('reads the app with its token taken from internalNumericId, never the name', async () => {
    mocks.readAppProvenance.mockResolvedValue(provenance());
    await expect(probes('fly').find(intent, journal)).resolves.toEqual({
      kind: 'fly',
      app: {
        token: '4817203',
        name: 'community-acme',
        organization: 'acme',
        network: 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
        createdAt: '2026-09-23T10:31:07Z',
        machines: 0,
        volumes: 0,
        ipAddresses: 0,
        certificates: 0,
        secretNames: [],
      },
    });
  });

  it('reports a same-name app in another organization as absent', async () => {
    mocks.readAppProvenance.mockResolvedValue(provenance({ organizationSlug: 'someone-else' }));
    await expect(probes('fly').find(intent, journal)).resolves.toEqual({ kind: 'absent' });
  });

  // `app: null` is how Fly answers an unknown name, and also how a server error can look.
  it('calls a missing app absent only when the organization listing agrees', async () => {
    mocks.readAppProvenance.mockResolvedValue(null);
    await expect(probes('fly').find(intent, journal)).resolves.toEqual({ kind: 'absent' });
    expect(mocks.readFlyApps).toHaveBeenCalledWith(options.fly, 'acme');

    mocks.readFlyApps.mockResolvedValue([{ id: 'community-acme', name: 'community-acme' }]);
    await expect(probes('fly').find(intent, journal)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    mocks.readFlyApps.mockRejectedValue(new Error('EXIT'));
    await expect(probes('fly').find(intent, journal)).rejects.toThrow();
  });

  it('confirms absence by token, and never by the provenance read alone', async () => {
    const probe = probes('fly');
    mocks.readAppProvenance.mockResolvedValue(provenance());
    await expect(probe.isGone(flyTarget)).resolves.toBe(false);
    mocks.readAppProvenance.mockResolvedValue(provenance({ internalNumericId: '9999999' }));
    await expect(probe.isGone(flyTarget)).resolves.toBe(true);
    mocks.readAppProvenance.mockResolvedValue(null);
    await expect(probe.isGone(flyTarget)).resolves.toBe(true);
    mocks.readFlyApps.mockResolvedValue([{ id: 'community-acme', name: 'community-acme' }]);
    await expect(probe.isGone(flyTarget)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('deletes by the proved name and reads whether the name is free', async () => {
    const probe = probes('fly');
    await probe.remove(flyTarget);
    expect(mocks.destroyFlyApp).toHaveBeenCalledWith(options.fly, 'community-acme');
    mocks.isAppNameAvailable.mockResolvedValue(false);
    await expect(probe.isNameReleased!(flyTarget)).resolves.toBe(false);
  });
});

describe('Neon removal probe', () => {
  const neonIntent = { ...intent, provider: 'neon' as const, organizationId: 'org-acme' };

  it('reads each same-name project with its default branch roles and databases', async () => {
    mocks.readNeonProjects.mockResolvedValue([
      {
        id: 'project-9',
        organizationId: 'org-acme',
        name: 'community-acme',
        regionId: 'aws-us-east-2',
        postgresVersion: 17,
        createdAt: '2026-09-23T10:31:07Z',
      },
      {
        id: 'project-8',
        organizationId: 'org-acme',
        name: 'community-acme',
        regionId: 'aws-us-east-2',
        postgresVersion: 17,
      },
      {
        id: 'project-other',
        organizationId: 'org-acme',
        name: 'another',
        regionId: 'aws-us-east-2',
        postgresVersion: 17,
      },
    ]);
    mocks.readNeonBranches.mockImplementation(async (_options, projectId: string) =>
      projectId === 'project-9'
        ? [{ id: 'br-1', isDefault: true }]
        : [
            { id: 'br-2', isDefault: true },
            { id: 'br-3', isDefault: true },
          ]
    );
    mocks.readNeonBranchTopology.mockResolvedValue({
      roles: [{ branchId: 'br-1', name: 'community_7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a' }],
      databases: [{ id: 'db', branchId: 'br-1', name: 'community', ownerName: 'x' }],
    });
    await expect(probes('neon').find(neonIntent, journal)).resolves.toEqual({
      kind: 'neon',
      projects: [
        {
          token: 'project-9',
          name: 'community-acme',
          organization: 'org-acme',
          region: 'aws-us-east-2',
          createdAt: '2026-09-23T10:31:07Z',
          branchCount: 1,
          defaultBranchCount: 1,
          roles: ['community_7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a'],
          databases: ['community'],
        },
        {
          token: 'project-8',
          name: 'community-acme',
          organization: 'org-acme',
          region: 'aws-us-east-2',
          branchCount: 2,
          defaultBranchCount: 2,
          roles: [],
          databases: [],
        },
      ],
    });
    expect(mocks.readNeonBranchTopology).toHaveBeenCalledTimes(1);
  });

  it('confirms absence by project id and deletes by project id', async () => {
    const target = {
      ...flyTarget,
      provider: 'neon' as const,
      token: 'project-9',
      organization: 'org-acme',
    };
    mocks.readNeonProjects.mockResolvedValue([{ id: 'project-9' }]);
    await expect(probes('neon').isGone(target)).resolves.toBe(false);
    mocks.readNeonProjects.mockResolvedValue([]);
    await expect(probes('neon').isGone(target)).resolves.toBe(true);
    await probes('neon').remove(target);
    expect(mocks.deleteNeonProject).toHaveBeenCalledWith(options.neon, 'project-9');
  });
});

describe('Tigris removal probe', () => {
  const target: RemovalTarget = {
    provider: 'tigris',
    token: 'addon-5',
    resourceName: 'community-acme',
    organization: 'acme',
    proof: 'binding',
    appName: 'community-acme',
  };
  const onApp = (addOns: Array<{ id: string }>, totalCount = addOns.length) => ({
    internalNumericId: '4817203',
    name: 'community-acme',
    network: 'dorkos-x',
    organizationSlug: 'acme',
    totalCount,
    addOns: addOns.map((addOn) => ({
      ...addOn,
      name: 'community-acme',
      createdAt: '2026-09-23T10:33:12Z',
      organizationSlug: 'acme',
    })),
  });

  it('cannot read absence without the app or with a list cut short', async () => {
    mocks.readTigrisOnApp.mockResolvedValue(null);
    await expect(probes('tigris').isGone(target)).rejects.toThrow();
    mocks.readTigrisOnApp.mockResolvedValue(onApp([], 1));
    await expect(probes('tigris').isGone(target)).rejects.toThrow();
    mocks.readTigrisOnApp.mockResolvedValue(onApp([]));
    await expect(probes('tigris').isGone(target)).resolves.toBe(true);
    mocks.readTigrisOnApp.mockResolvedValue(onApp([{ id: 'addon-5' }]));
    await expect(probes('tigris').isGone(target)).resolves.toBe(false);
  });

  it('records only the two credential digests before the delete', async () => {
    mocks.readFlySecretInventory.mockResolvedValue([
      { name: 'AWS_ACCESS_KEY_ID', digest: 'd1' },
      { name: 'AWS_SECRET_ACCESS_KEY', digest: 'd2' },
      { name: 'COMMUNITY_AUTH_SECRET', digest: 'd3' },
    ]);
    await expect(probes('tigris').readPriorSecretDigests!(target)).resolves.toEqual({
      AWS_ACCESS_KEY_ID: 'd1',
      AWS_SECRET_ACCESS_KEY: 'd2',
    });
  });

  it('unsets both credential names and trusts only the readback', async () => {
    const probe = probes('tigris');
    mocks.readFlySecretInventory.mockResolvedValue([{ name: 'OTHER', digest: 'x' }]);
    await expect(probe.clearBoundSecrets!(target)).resolves.toBe(true);
    expect(mocks.unsetFlyTigrisSecrets).toHaveBeenCalledWith(options.fly, 'community-acme');

    // A failed unset whose readback is clean still counts: the names are gone.
    mocks.unsetFlyTigrisSecrets.mockRejectedValueOnce(new Error('exit'));
    await expect(probe.clearBoundSecrets!(target)).resolves.toBe(true);

    // An unset that reports success but leaves either name does not.
    for (const left of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      mocks.readFlySecretInventory.mockResolvedValueOnce([{ name: left, digest: 'x' }]);
      await expect(probe.clearBoundSecrets!(target)).resolves.toBe(false);
    }
  });

  it('deletes the add-on by the proved name', async () => {
    await probes('tigris').remove(target);
    expect(mocks.deleteTigris).toHaveBeenCalledWith('community-acme');
  });
});
