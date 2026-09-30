/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { createLaunchPlan } from '../plan.js';

const mocks = vi.hoisted(() => ({
  readFlyRuntimeInventory: vi.fn(),
  verifyCommunityHealth: vi.fn(async () => undefined),
}));
vi.mock('../fly-read.js', () => ({ readFlyRuntimeInventory: mocks.readFlyRuntimeInventory }));
vi.mock('../health.js', () => ({ verifyCommunityHealth: mocks.verifyCommunityHealth }));

const { createDefaultCommunityOwnerDependencies } = await import('../runtime/default-owner.js');
const { createDefaultCommunityDeployDependencies } = await import('../runtime/default-deploy.js');

const INDEX = `sha256:${'a'.repeat(64)}`;
const PLATFORM = `sha256:${'f'.repeat(64)}`;
const plan = createLaunchPlan({
  dorkosVersion: '0.92.0',
  imageDigest: INDEX,
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

// What Fly reports after running the attested index: its linux/amd64 manifest (DOR-2586).
function runtimeReporting(digest: string) {
  return {
    machines: [
      {
        id: 'machine-id',
        name: 'machine',
        state: 'started',
        region: 'ord',
        imageDigest: digest,
        imageRepository: 'ghcr.io/dork-labs/dorkos-community',
        checks: [{ name: 'health', status: 'passing' }],
      },
    ],
    releases: [
      {
        id: 'release-id',
        imageRef: `ghcr.io/dork-labs/dorkos-community@${digest}`,
        status: 'complete',
        stable: false,
        version: 2,
      },
    ],
    addresses: [{ address: '203.0.113.1', type: 'v4', region: '' }],
  };
}

function owner(platformDigest: () => Promise<string>) {
  return createDefaultCommunityOwnerDependencies({
    options: {
      fly: { executable: 'fly', env: {}, timeoutMs: 1_000 },
      neon: { executable: 'neonctl', env: {}, timeoutMs: 1_000 },
      graphqlTimeoutMs: 1_000,
    },
    plan,
    env: {},
    persist: vi.fn(),
    now: () => '2026-09-30T00:00:00.000Z',
    platformDigest,
  });
}

describe('owner step runtime check', () => {
  it('checks the running Machine against the platform digest Fly reports', async () => {
    mocks.readFlyRuntimeInventory.mockResolvedValue(runtimeReporting(PLATFORM));
    await expect(owner(async () => PLATFORM).verifyRuntimeAndHealth()).resolves.toBeUndefined();
    expect(mocks.verifyCommunityHealth).toHaveBeenCalledOnce();
  });

  it('still refuses a Machine running anything else', async () => {
    mocks.readFlyRuntimeInventory.mockResolvedValue(runtimeReporting(`sha256:${'9'.repeat(64)}`));
    await expect(owner(async () => PLATFORM).verifyRuntimeAndHealth()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

describe('deploy step runtime check', () => {
  const deploy = () =>
    createDefaultCommunityDeployDependencies({
      options: {
        fly: { executable: 'fly', env: {}, timeoutMs: 1_000 },
        neon: { executable: 'neonctl', env: {}, timeoutMs: 1_000 },
        graphqlTimeoutMs: 1_000,
      },
      plan,
      latestJournal: () => {
        throw new Error('unused');
      },
      persist: vi.fn(),
      now: () => '2026-09-30T00:00:00.000Z',
      resolvePlatformDigest: async () => PLATFORM,
    });

  it('proves a new and an existing deployment against the platform digest, not the index', () => {
    const reported = runtimeReporting(PLATFORM);
    expect(deploy().verifyExistingRuntime(reported, PLATFORM)).toBe(reported);
    expect(deploy().verifyNewRuntime(reported, [], PLATFORM)).toBe(reported);
    // The live failure: Fly reports the platform manifest, so the index never matches.
    expect(() => deploy().verifyExistingRuntime(reported, INDEX)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });
});
