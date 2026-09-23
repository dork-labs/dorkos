import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LaunchJournalSchema } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import { createDefaultCommunityCreationDependencies } from '../runtime/default-services.js';

const mocks = vi.hoisted(() => ({
  createNeonProject: vi.fn(),
  readFlyApps: vi.fn(),
  readFlyOrganizationId: vi.fn(),
  readFlySecretInventory: vi.fn(),
  verifyTigrisSecretNames: vi.fn(),
  createTigris: vi.fn(),
}));

vi.mock('../fly-mutate.js', () => ({ createFlyApp: vi.fn() }));
vi.mock('../fly-read.js', () => ({
  readFlyApps: mocks.readFlyApps,
  readFlyOrganizationId: mocks.readFlyOrganizationId,
  readFlyOrganizations: vi.fn(),
  readFlyRegions: vi.fn(),
}));
vi.mock('../neon-mutate.js', () => ({ createNeonProject: mocks.createNeonProject }));
vi.mock('../neon-read.js', () => ({
  readNeonBranches: vi.fn(),
  readNeonBranchTopology: vi.fn(),
  readNeonEndpoints: vi.fn(),
  readNeonOrganizations: vi.fn(),
  readNeonProjects: vi.fn(),
  readNeonRegions: vi.fn(),
}));
vi.mock('../tigris-session.js', () => ({
  readFlySecretInventory: mocks.readFlySecretInventory,
  verifyTigrisSecretNames: mocks.verifyTigrisSecretNames,
  readFlySessionCredential: vi.fn(async () => ({
    use: async <T>(consumer: (token: string) => Promise<T>) => consumer('fixture-token'),
    dispose: vi.fn(),
  })),
}));
vi.mock('../fly-graphql-client.js', () => ({
  FlyGraphqlClientError: class extends Error {},
  FlyTigrisGraphqlClient: class {
    createTigris = mocks.createTigris;
  },
}));

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

function dependencies() {
  const latest = LaunchJournalSchema.parse({
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
  });
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

describe('default Community creation boundaries', () => {
  it('returns the Neon creation identity before any topology readback', async () => {
    await expect(dependencies().neon.create()).resolves.toEqual({
      id: 'project_fixture_01',
      organizationId: 'org_fixture_01',
      name: 'community-fixture',
    });
  });

  it('returns the Tigris creation identity before reading attached secret inventory', async () => {
    await expect(dependencies().tigris.create()).resolves.toEqual({
      id: 'addon_fixture_01',
      organizationId: 'fixture-org',
      name: 'community-fixture-bucket',
      bindingId: 'app_fixture_01',
    });
    expect(mocks.readFlySecretInventory).not.toHaveBeenCalled();
    expect(mocks.verifyTigrisSecretNames).not.toHaveBeenCalled();
  });

  it('creates Tigris under the Fly organization ID resolved from the planned slug', async () => {
    await dependencies().tigris.create();
    expect(mocks.readFlyOrganizationId).toHaveBeenCalledWith(expect.anything(), 'fixture-org');
    expect(mocks.createTigris).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_fixture_graphql_01', appId: 'app_fixture_01' })
    );
  });
});
