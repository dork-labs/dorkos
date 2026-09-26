import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import { createDefaultCommunityCreationDependencies } from '../runtime/default-services.js';

const mocks = vi.hoisted(() => ({
  createFlyApp: vi.fn(),
  createNeonProject: vi.fn(),
  readFlyApps: vi.fn(),
  readFlyOrganizationId: vi.fn(),
  readFlySecretInventory: vi.fn(),
  createTigris: vi.fn(),
  readTigris: vi.fn(),
  readAppProvenance: vi.fn(),
  readNeonProjects: vi.fn(),
  readNeonBranches: vi.fn(),
  readNeonBranchTopology: vi.fn(),
  readNeonEndpoints: vi.fn(),
}));

vi.mock('../fly-mutate.js', () => ({ createFlyApp: mocks.createFlyApp }));
vi.mock('../fly-read.js', () => ({
  readFlyApps: mocks.readFlyApps,
  readFlyOrganizationId: mocks.readFlyOrganizationId,
  readFlyOrganizations: vi.fn(),
  readFlyRegions: vi.fn(),
}));
vi.mock('../neon-mutate.js', () => ({ createNeonProject: mocks.createNeonProject }));
vi.mock('../neon-read.js', () => ({
  readNeonBranches: mocks.readNeonBranches,
  readNeonBranchTopology: mocks.readNeonBranchTopology,
  readNeonEndpoints: mocks.readNeonEndpoints,
  readNeonOrganizations: vi.fn(),
  readNeonProjects: mocks.readNeonProjects,
  readNeonRegions: vi.fn(),
}));
vi.mock('../tigris-session.js', async (importOriginal) => ({
  // The real credential checks run; only the process boundaries are replaced.
  ...(await importOriginal<typeof import('../tigris-session.js')>()),
  readFlySecretInventory: mocks.readFlySecretInventory,
  readFlySessionCredential: vi.fn(async () => ({
    use: async <T>(consumer: (token: string) => Promise<T>) => consumer('fixture-token'),
    dispose: vi.fn(),
  })),
}));
vi.mock('../fly-graphql-client.js', () => ({
  FlyGraphqlClientError: class extends Error {},
  FlyTigrisGraphqlClient: class {
    createTigris = mocks.createTigris;
    readTigris = mocks.readTigris;
    readAppProvenance = mocks.readAppProvenance;
  },
}));

const marker = '7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a';
const network = `dorkos-${marker}`;

const plan = createLaunchPlan({
  dorkosVersion: '0.76.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  fly: {
    organizationId: 'fixture-org',
    organizationName: 'Fixture Org',
    appName: 'community-fixture-app',
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org_fixture_01',
    organizationName: 'Fixture Org',
    projectName: 'community-fixture',
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: 'community-fixture-bucket', private: true },
});

function baseJournal(update: Partial<LaunchJournal> = {}): LaunchJournal {
  return LaunchJournalSchema.parse({
    schemaVersion: 1,
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 0,
    planHash: 'b'.repeat(64),
    releaseDigest: plan.imageDigest,
    state: 'fly_app_created',
    pendingIntent: null,
    resources: { flyAppId: 'app_fixture_01' },
    verifiedBindings: [],
    completedSteps: ['planned', 'fly_app_created'],
    lastSafeError: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...update,
  });
}

function dependencies(latest: LaunchJournal = baseJournal()) {
  return createDefaultCommunityCreationDependencies({
    options: {
      fly: { executable: 'fly', env: {}, timeoutMs: 1_000 },
      neon: { executable: 'neonctl', env: {}, timeoutMs: 1_000 },
      graphqlTimeoutMs: 1_000,
    },
    plan,
    latestJournal: () => latest,
    persist: vi.fn(),
    now: () => '2026-09-21T00:00:01.000Z',
    confirmTigrisTerms: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createNeonProject.mockResolvedValue({
    id: 'project_fixture_01',
    organizationId: 'org_fixture_01',
    name: 'community-fixture',
    regionId: 'aws-us-east-2',
    postgresVersion: 17,
  });
  mocks.readFlyApps.mockResolvedValue([
    {
      id: 'app_fixture_01',
      name: 'community-fixture-app',
      organizationSlug: 'fixture-org',
      status: 'deployed',
    },
  ]);
  mocks.readFlyOrganizationId.mockResolvedValue('org_fixture_graphql_01');
  mocks.readAppProvenance.mockResolvedValue(appProvenance());
  mocks.readNeonProjects.mockResolvedValue([
    {
      id: 'project_fixture_01',
      organizationId: 'org_fixture_01',
      name: 'community-fixture',
      regionId: 'aws-us-east-2',
      postgresVersion: 17,
    },
  ]);
  mocks.readNeonBranches.mockResolvedValue([{ id: 'br-fixture-01', isDefault: true }]);
  mocks.readNeonBranchTopology.mockResolvedValue(neonTopology(`community_${marker}`));
  mocks.readNeonEndpoints.mockResolvedValue([
    { id: 'ep-fixture-01', type: 'read_write', regionId: 'aws-us-east-2' },
  ]);
  mocks.readTigris.mockResolvedValue({
    addOnId: 'addon_fixture_01',
    addOnName: 'community-fixture-bucket',
    status: 'ready',
    organizationSlug: 'fixture-org',
    providerName: 'tigris',
    appId: 'app_fixture_01',
    appName: 'community-fixture-app',
    public: false,
  });
  mocks.readFlySecretInventory.mockResolvedValue([
    { name: 'AWS_ACCESS_KEY_ID', digest: 'fresh-access', status: 'Deployed' },
    { name: 'AWS_SECRET_ACCESS_KEY', digest: 'fresh-secret', status: 'Deployed' },
  ]);
  mocks.createTigris.mockResolvedValue({
    addOnId: 'addon_fixture_01',
    addOnName: 'community-fixture-bucket',
    status: 'ready',
    organizationSlug: 'fixture-org',
    providerName: 'tigris',
    appId: 'app_fixture_01',
    appName: 'community-fixture-app',
    public: false,
  });
});

function appProvenance(update: Record<string, unknown> = {}) {
  return {
    id: 'app_fixture_01',
    internalNumericId: '4817203',
    name: 'community-fixture-app',
    network,
    createdAt: '2026-09-23T10:31:07Z',
    organizationSlug: 'fixture-org',
    machineCount: 0,
    volumeCount: 0,
    ipAddressCount: 0,
    certificateCount: 0,
    secretNames: [],
    ...update,
  };
}

function neonTopology(roleName: string) {
  return {
    databases: [
      { id: 'db_fixture_01', branchId: 'br-fixture-01', name: 'community', ownerName: roleName },
    ],
    roles: [{ branchId: 'br-fixture-01', name: roleName }],
  };
}

const inFlight = () => ({ journal: baseJournal(), provenanceMarker: marker });

describe('default Community creation boundaries', () => {
  it('returns the Neon creation identity before any topology readback', async () => {
    await expect(dependencies().neon.create(marker)).resolves.toEqual({
      id: 'project_fixture_01',
      organizationId: 'org_fixture_01',
      name: 'community-fixture',
    });
  });

  it('returns the Tigris creation identity before reading attached secret inventory', async () => {
    await expect(dependencies().tigris.create(marker)).resolves.toEqual({
      id: 'addon_fixture_01',
      organizationId: 'fixture-org',
      name: 'community-fixture-bucket',
      bindingId: 'app_fixture_01',
    });
    expect(mocks.readFlySecretInventory).not.toHaveBeenCalled();
  });

  it('creates Tigris under the Fly organization ID resolved from the planned slug', async () => {
    await dependencies().tigris.create(marker);
    expect(mocks.readFlyOrganizationId).toHaveBeenCalledWith(expect.anything(), 'fixture-org');
    expect(mocks.createTigris).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_fixture_graphql_01', appId: 'app_fixture_01' })
    );
  });

  it('creates the Fly app on the marker network and hands the fallback a provenance read', async () => {
    mocks.createFlyApp.mockResolvedValue({
      id: 'app_fixture_01',
      name: 'community-fixture-app',
      organizationSlug: 'fixture-org',
      status: '',
    });
    await dependencies().fly.create(marker);
    expect(mocks.createFlyApp).toHaveBeenCalledWith(
      expect.anything(),
      'community-fixture-app',
      'fixture-org',
      network,
      expect.any(Function)
    );
    const readProvenance = mocks.createFlyApp.mock.calls[0]![4] as (
      name: string
    ) => Promise<unknown>;
    await expect(readProvenance('community-fixture-app')).resolves.toMatchObject({ network });
    expect(mocks.readAppProvenance).toHaveBeenCalledWith('community-fixture-app');
  });

  it('records the Fly network exactly as the provenance read reports it', async () => {
    await expect(dependencies().fly.inspect('app_fixture_01', inFlight())).resolves.toEqual({
      id: 'app_fixture_01',
      organizationId: 'fixture-org',
      name: 'community-fixture-app',
      provenance: { flyNetwork: network },
    });
  });

  it('rejects a Fly app whose provenance read does not match the run', async () => {
    const reads = [
      // `apps list` always reports an empty network; the provenance read must never be that.
      appProvenance({ network: '' }),
      appProvenance({ network: null }),
      appProvenance({ network: `dorkos-${'0'.repeat(32)}` }),
      appProvenance({ id: 'app_other' }),
      appProvenance({ name: 'community-other' }),
      appProvenance({ organizationSlug: 'personal' }),
      null,
    ];
    for (const read of reads) {
      mocks.readAppProvenance.mockResolvedValueOnce(read);
      await expect(
        dependencies().fly.inspect('app_fixture_01', inFlight()),
        JSON.stringify(read)
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('rechecks a completed Fly app against the journaled network', async () => {
    const completed = baseJournal({ provenance: { flyNetwork: network } });
    await expect(
      dependencies(completed).fly.inspect('app_fixture_01', { journal: completed })
    ).resolves.toMatchObject({ provenance: { flyNetwork: network } });

    mocks.readAppProvenance.mockResolvedValueOnce(appProvenance({ network: 'dorkos-elsewhere' }));
    await expect(
      dependencies(completed).fly.inspect('app_fixture_01', { journal: completed })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  // A launch already in progress when this shipped must be re-checked exactly as before: through
  // the listing it has always used, never the newer provenance read.
  it('re-checks a run started before markers through the app listing, and records no network', async () => {
    await expect(
      dependencies().fly.inspect('app_fixture_01', { journal: baseJournal() })
    ).resolves.toEqual({
      id: 'app_fixture_01',
      organizationId: 'fixture-org',
      name: 'community-fixture-app',
    });
    expect(mocks.readFlyApps).toHaveBeenCalledWith(expect.anything(), 'fixture-org');
    expect(mocks.readAppProvenance).not.toHaveBeenCalled();

    mocks.readFlyApps.mockResolvedValueOnce([]);
    await expect(
      dependencies().fly.inspect('app_fixture_01', { journal: baseJournal() })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(mocks.readAppProvenance).not.toHaveBeenCalled();
  });

  it('re-checks a marked run through the provenance read, never the listing', async () => {
    const completed = baseJournal({ provenance: { flyNetwork: network } });
    for (const context of [inFlight(), { journal: completed }]) {
      await expect(
        dependencies(completed).fly.inspect('app_fixture_01', context)
      ).resolves.toMatchObject({
        provenance: { flyNetwork: network },
      });
    }
    expect(mocks.readAppProvenance).toHaveBeenCalledTimes(2);
    expect(mocks.readFlyApps).not.toHaveBeenCalled();
  });

  it('creates the Neon project with the marker role instead of a fixed one', async () => {
    await dependencies().neon.create(marker);
    expect(mocks.createNeonProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ roleName: `community_${marker}`, databaseName: 'community' })
    );
  });

  it('requires the in-flight marker role on the Neon project and its database owner', async () => {
    await expect(
      dependencies().neon.inspect('project_fixture_01', inFlight())
    ).resolves.toMatchObject({ relatedResources: { neonRoleId: `community_${marker}` } });

    for (const topology of [
      neonTopology('community_owner'),
      neonTopology(`community_${'0'.repeat(32)}`),
      {
        ...neonTopology(`community_${marker}`),
        databases: neonTopology('community_owner').databases,
      },
    ]) {
      mocks.readNeonBranchTopology.mockResolvedValueOnce(topology);
      await expect(
        dependencies().neon.inspect('project_fixture_01', inFlight())
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  // A finished Neon step is re-checked on every resume. It must match the role the journal
  // recorded, not one derived from an intent marker, which is gone once the step completes.
  it.each([`community_${marker}`, 'community_owner'])(
    're-checks a finished Neon step against the journaled role %s',
    async (roleName) => {
      const finished = baseJournal({
        resources: { flyAppId: 'app_fixture_01', neonRoleId: roleName },
      });
      mocks.readNeonBranchTopology.mockResolvedValue(neonTopology(roleName));
      await expect(
        dependencies(finished).neon.inspect('project_fixture_01', { journal: finished })
      ).resolves.toMatchObject({ relatedResources: { neonRoleId: roleName } });

      // Any other role on the project is drift, including the one the journal did not record.
      const other = roleName === 'community_owner' ? `community_${marker}` : 'community_owner';
      mocks.readNeonBranchTopology.mockResolvedValue(neonTopology(other));
      await expect(
        dependencies(finished).neon.inspect('project_fixture_01', { journal: finished })
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  );

  it('keeps the journaled Neon role, and the old fixed role for a pre-marker intent', async () => {
    const journaled = baseJournal({
      resources: { flyAppId: 'app_fixture_01', neonRoleId: 'community_owner' },
    });
    mocks.readNeonBranchTopology.mockResolvedValue(neonTopology('community_owner'));
    await expect(
      dependencies(journaled).neon.inspect('project_fixture_01', { journal: journaled })
    ).resolves.toMatchObject({ relatedResources: { neonRoleId: 'community_owner' } });
    await expect(
      dependencies().neon.inspect('project_fixture_01', { journal: baseJournal() })
    ).resolves.toMatchObject({ relatedResources: { neonRoleId: 'community_owner' } });
  });

  // After a removal, a re-created bucket must bring its own credentials: a digest equal to one the
  // removed bucket had means the app still holds stale values, and the step must not continue.
  it('refuses a Tigris bucket whose credentials match a removed bucket', async () => {
    const removal = (priorSecretDigests: Record<string, string>) => ({
      provider: 'tigris' as const,
      token: 'addon_removed_01',
      resourceName: 'community-fixture-bucket',
      proof: 'binding' as const,
      priorSecretDigests,
      requestedAt: '2026-09-23T10:40:00.000Z',
      removedAt: '2026-09-23T10:41:00.000Z',
    });
    const context = (priorSecretDigests: Record<string, string>) => ({
      journal: baseJournal({ removals: [removal(priorSecretDigests)] }),
      provenanceMarker: marker,
    });

    await expect(
      dependencies().tigris.inspect(
        'addon_fixture_01',
        context({ AWS_ACCESS_KEY_ID: 'old-access', AWS_SECRET_ACCESS_KEY: 'old-secret' })
      )
    ).resolves.toMatchObject({ id: 'addon_fixture_01' });

    for (const prior of [
      { AWS_ACCESS_KEY_ID: 'fresh-access', AWS_SECRET_ACCESS_KEY: 'old-secret' },
      { AWS_ACCESS_KEY_ID: 'old-access', AWS_SECRET_ACCESS_KEY: 'fresh-secret' },
    ]) {
      await expect(
        dependencies().tigris.inspect('addon_fixture_01', context(prior)),
        JSON.stringify(prior)
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }

    mocks.readFlySecretInventory.mockResolvedValueOnce([
      { name: 'AWS_ACCESS_KEY_ID', digest: 'fresh-access', status: 'Deployed' },
    ]);
    await expect(
      dependencies().tigris.inspect(
        'addon_fixture_01',
        context({ AWS_ACCESS_KEY_ID: 'old-access', AWS_SECRET_ACCESS_KEY: 'old-secret' })
      )
    ).rejects.toMatchObject({ code: 'MISSING_TIGRIS_SECRETS' });
  });
});
