/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLaunchPlan } from '../plan.js';
import { ProviderCommandError } from '../provider-process.js';

const mocks = vi.hoisted(() => ({
  readFlyRuntimeInventory: vi.fn(),
  deployFlyImage: vi.fn(async () => ({ operation: 'deploy' as const })),
  verifyCommunityHealth: vi.fn(async () => undefined),
}));
vi.mock('../fly-read.js', () => ({ readFlyRuntimeInventory: mocks.readFlyRuntimeInventory }));
vi.mock('../health.js', () => ({ verifyCommunityHealth: mocks.verifyCommunityHealth }));
vi.mock('../fly-config.js', () => ({
  withCommunityFlyConfig: <T>(_plan: unknown, consumer: (path: string) => Promise<T>) =>
    consumer('/tmp/fly.toml'),
}));
vi.mock('../fly-mutate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fly-mutate.js')>()),
  deployFlyImage: mocks.deployFlyImage,
}));

const { createDefaultCommunityOwnerDependencies } = await import('../runtime/default-owner.js');

// The attested index is what gets deployed; Fly reports its linux/amd64 manifest (DOR-2586).
const DIGEST = `sha256:${'a'.repeat(64)}`;
const PLATFORM = `sha256:${'6'.repeat(64)}`;
const REPOSITORY = 'ghcr.io/dork-labs/dorkos-community';
const plan = createLaunchPlan({
  dorkosVersion: '0.92.0',
  imageDigest: DIGEST,
  fly: {
    organizationId: 'dork-labs',
    organizationName: 'Dork Labs',
    appName: 'dorkos-community-test',
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org-dorian',
    organizationName: 'Dorian',
    projectName: 'dorkos-community-test',
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: 'dorkos-community-test', private: true },
});

function runtime(update: { digest?: string; status?: string; version?: number } = {}) {
  const digest = update.digest ?? PLATFORM;
  return {
    machines: [
      {
        id: 'machine-id',
        name: 'machine',
        state: 'started',
        region: 'ord',
        imageDigest: digest,
        imageRepository: REPOSITORY,
        checks: [{ name: 'health', status: 'passing' }],
      },
    ],
    releases: [
      {
        id: `release-${update.version ?? 2}`,
        imageRef: `${REPOSITORY}@${digest}`,
        status: update.status ?? 'complete',
        stable: false,
        version: update.version ?? 2,
      },
    ],
    addresses: [{ address: '203.0.113.1', type: 'v4', region: '' }],
  };
}

const owner = () =>
  createDefaultCommunityOwnerDependencies({
    options: {
      fly: { executable: 'fly', env: {}, timeoutMs: 1_000 },
      neon: { executable: 'neonctl', env: {}, timeoutMs: 1_000 },
      graphqlTimeoutMs: 1_000,
    },
    plan,
    env: {},
    persist: vi.fn(),
    now: () => '2026-09-30T00:00:00.000Z',
    platformDigest: async () => PLATFORM,
  });

beforeEach(() => vi.clearAllMocks());

// DOR-2169: the owner step's runtime check gets the same narrow recovery as the deploy step.
describe('owner step runtime check after a cut-off secrets deploy', () => {
  it('re-deploys the pinned image over an interrupted release of it, then proves the new one', async () => {
    mocks.readFlyRuntimeInventory
      .mockResolvedValueOnce(runtime({ status: 'interrupted', version: 2 }))
      .mockResolvedValueOnce(runtime({ version: 3 }));
    await expect(owner().verifyRuntimeAndHealth()).resolves.toBeUndefined();
    expect(mocks.deployFlyImage).toHaveBeenCalledWith(
      expect.anything(),
      'dorkos-community-test',
      `${REPOSITORY}@${DIGEST}`,
      '/tmp/fly.toml'
    );
    expect(mocks.verifyCommunityHealth).toHaveBeenCalledOnce();
  });

  it('stops without deploying over anything else, and says what to check', async () => {
    mocks.readFlyRuntimeInventory.mockResolvedValue(
      runtime({ digest: `sha256:${'b'.repeat(64)}`, status: 'interrupted' })
    );
    await expect(owner().verifyRuntimeAndHealth()).rejects.toMatchObject({
      name: 'UnprovenFlyRuntimeError',
      message: expect.stringContaining('fly status --app dorkos-community-test'),
    });
    expect(mocks.deployFlyImage).not.toHaveBeenCalled();
    expect(mocks.verifyCommunityHealth).not.toHaveBeenCalled();
  });

  it('never deploys over a runtime it could not read', async () => {
    mocks.readFlyRuntimeInventory.mockRejectedValue(new ProviderCommandError('TIMEOUT'));
    await expect(owner().verifyRuntimeAndHealth()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(mocks.deployFlyImage).not.toHaveBeenCalled();
  });

  it('passes a healthy complete deployment without deploying', async () => {
    mocks.readFlyRuntimeInventory.mockResolvedValue(runtime());
    await expect(owner().verifyRuntimeAndHealth()).resolves.toBeUndefined();
    expect(mocks.deployFlyImage).not.toHaveBeenCalled();
  });
});
