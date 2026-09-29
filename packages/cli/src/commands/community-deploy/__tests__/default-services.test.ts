import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TigrisBucketCredentials } from '../fly-graphql-contract.js';
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
  readTigris: vi.fn(),
  readTigrisCredentials: vi.fn(),
  stageFlySecrets: vi.fn(),
}));

vi.mock('../fly-mutate.js', () => ({
  createFlyApp: vi.fn(),
  stageFlySecrets: mocks.stageFlySecrets,
}));
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
vi.mock('../tigris-session.js', async (importOriginal) => ({
  EXPECTED_TIGRIS_SECRET_NAMES: (await importOriginal<typeof import('../tigris-session.js')>())
    .EXPECTED_TIGRIS_SECRET_NAMES,
  TigrisSessionError: (await importOriginal<typeof import('../tigris-session.js')>())
    .TigrisSessionError,
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
    readTigris = mocks.readTigris;
    readTigrisCredentials = mocks.readTigrisCredentials;
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

const tigrisIdentity = {
  addOnId: 'addon_fixture_01',
  addOnName: 'community-fixture-bucket',
  status: 'ready',
  organizationSlug: 'fixture-org',
  providerName: 'tigris',
  appId: 'app_fixture_01',
  appName: 'community-fixture-app',
  public: false,
};

const KEYS = { AWS_ACCESS_KEY_ID: 'tid_fixture', AWS_SECRET_ACCESS_KEY: 'tsec_fixture' };
const keyRows = [
  { name: 'AWS_ACCESS_KEY_ID', digest: 'digest-a', status: 'Staged' as const },
  { name: 'AWS_SECRET_ACCESS_KEY', digest: 'digest-b', status: 'Staged' as const },
];

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
  mocks.createTigris.mockResolvedValue({ identity: tigrisIdentity, credentials: null });
  mocks.readTigris.mockResolvedValue(tigrisIdentity);
  mocks.readTigrisCredentials.mockResolvedValue(null);
  mocks.readFlySecretInventory.mockResolvedValue([]);
  mocks.stageFlySecrets.mockResolvedValue({ operation: 'secrets-stage' });
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

  // Fly's servers never set the bucket's keys on the app; flyctl copies them from the create
  // answer (`setSecretsFromExtension`). The live gate on dorkos@0.92.0 stopped here (DOR-2559).
  describe('putting the bucket keys on the app', () => {
    it('stages the keys from the create answer before any other read, then proves them', async () => {
      const credentials = new TigrisBucketCredentials(
        KEYS.AWS_ACCESS_KEY_ID,
        KEYS.AWS_SECRET_ACCESS_KEY
      );
      mocks.createTigris.mockResolvedValueOnce({ identity: tigrisIdentity, credentials });
      mocks.readFlySecretInventory.mockResolvedValue(keyRows);
      const deps = dependencies();
      await deps.tigris.create();
      mocks.readFlyApps.mockClear();
      await expect(deps.tigris.inspect('addon_fixture_01')).resolves.toMatchObject({
        id: 'addon_fixture_01',
      });
      expect(mocks.stageFlySecrets).toHaveBeenCalledOnce();
      // The keys exist only in memory, so nothing that can fail runs before they are staged.
      const staged = mocks.stageFlySecrets.mock.invocationCallOrder[0]!;
      for (const read of [mocks.readFlyApps, mocks.readTigris, mocks.readFlySecretInventory]) {
        expect(read.mock.invocationCallOrder[0]).toBeGreaterThan(staged);
      }
      expect(mocks.stageFlySecrets).toHaveBeenCalledWith(
        expect.anything(),
        'community-fixture-app',
        KEYS
      );
      expect(mocks.readTigrisCredentials).not.toHaveBeenCalled();
      expect(mocks.verifyTigrisSecretNames).toHaveBeenCalledWith(keyRows);
      // The keys are dropped as soon as they are on the app.
      await expect(credentials.use(async () => true)).rejects.toThrow();
    });

    it('has already staged the keys when a read after creation fails', async () => {
      mocks.createTigris.mockResolvedValueOnce({
        identity: tigrisIdentity,
        credentials: new TigrisBucketCredentials(
          KEYS.AWS_ACCESS_KEY_ID,
          KEYS.AWS_SECRET_ACCESS_KEY
        ),
      });
      mocks.readTigris.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'TIMEOUT' }));
      const deps = dependencies();
      await deps.tigris.create();
      await expect(deps.tigris.inspect('addon_fixture_01')).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      expect(mocks.stageFlySecrets).toHaveBeenCalledWith(
        expect.anything(),
        'community-fixture-app',
        KEYS
      );
    });

    it('stops with the keys-specific code when staging failed and Fly will not resend them', async () => {
      mocks.createTigris.mockResolvedValueOnce({
        identity: tigrisIdentity,
        credentials: new TigrisBucketCredentials(
          KEYS.AWS_ACCESS_KEY_ID,
          KEYS.AWS_SECRET_ACCESS_KEY
        ),
      });
      mocks.stageFlySecrets.mockRejectedValueOnce(
        Object.assign(new Error('x'), { code: 'TIMEOUT' })
      );
      const deps = dependencies();
      await deps.tigris.create();
      await expect(deps.tigris.inspect('addon_fixture_01')).rejects.toMatchObject({
        code: 'MISSING_TIGRIS_SECRETS',
      });
      expect(mocks.readTigrisCredentials).toHaveBeenCalledWith('addon_fixture_01');
    });

    it('neither reads nor sets keys that are already on the app', async () => {
      mocks.readFlySecretInventory.mockResolvedValue(keyRows);
      await dependencies().tigris.inspect('addon_fixture_01');
      expect(mocks.stageFlySecrets).not.toHaveBeenCalled();
      expect(mocks.readTigrisCredentials).not.toHaveBeenCalled();
    });

    it('re-reads the keys by exact ID when a resumed launch no longer holds them', async () => {
      mocks.readTigrisCredentials.mockResolvedValueOnce(
        new TigrisBucketCredentials(KEYS.AWS_ACCESS_KEY_ID, KEYS.AWS_SECRET_ACCESS_KEY)
      );
      mocks.readFlySecretInventory.mockResolvedValueOnce([]).mockResolvedValueOnce(keyRows);
      await dependencies().tigris.inspect('addon_fixture_01');
      expect(mocks.readTigrisCredentials).toHaveBeenCalledWith('addon_fixture_01');
      expect(mocks.stageFlySecrets).toHaveBeenCalledWith(
        expect.anything(),
        'community-fixture-app',
        KEYS
      );
    });

    it('stops without setting anything when Fly no longer returns the keys', async () => {
      await expect(dependencies().tigris.inspect('addon_fixture_01')).rejects.toMatchObject({
        code: 'MISSING_TIGRIS_SECRETS',
      });
      expect(mocks.stageFlySecrets).not.toHaveBeenCalled();
    });

    it('never overwrites an app that already holds one of the two names', async () => {
      mocks.readFlySecretInventory.mockResolvedValue([keyRows[0]]);
      mocks.readTigrisCredentials.mockResolvedValue(
        new TigrisBucketCredentials(KEYS.AWS_ACCESS_KEY_ID, KEYS.AWS_SECRET_ACCESS_KEY)
      );
      await expect(dependencies().tigris.inspect('addon_fixture_01')).rejects.toMatchObject({
        code: 'MISSING_TIGRIS_SECRETS',
      });
      expect(mocks.stageFlySecrets).not.toHaveBeenCalled();
      expect(mocks.readTigrisCredentials).not.toHaveBeenCalled();
    });
  });
});
