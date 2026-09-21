import { describe, expect, it, vi } from 'vitest';
import { executeCommunityDeployPhase, type CommunityDeployPhaseDependencies } from '../deploy.js';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import type { FlySecretInventoryItem } from '../tigris-session.js';

const plan = createLaunchPlan({
  dorkosVersion: '0.76.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
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

function journal(update: Partial<LaunchJournal> = {}): LaunchJournal {
  return LaunchJournalSchema.parse({
    schemaVersion: 1,
    runId: '11111111-1111-4111-8111-111111111111',
    revision: 6,
    planHash: 'b'.repeat(64),
    releaseDigest: plan.imageDigest,
    state: 'bucket_created',
    pendingIntent: null,
    resources: {
      flyAppId: 'app-id',
      neonProjectId: 'project-id',
      tigrisBucketId: 'bucket-id',
    },
    secretDigests: {},
    verifiedBindings: [{ kind: 'bucket-to-app', sourceId: 'bucket-id', targetId: 'app-id' }],
    completedSteps: ['planned', 'fly_app_created', 'neon_project_created', 'bucket_created'],
    lastSafeError: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...update,
  });
}

const runtime = {
  machines: [
    {
      id: 'machine-id',
      name: 'machine-name',
      state: 'started',
      region: 'ord',
      imageDigest: plan.imageDigest,
      imageRepository: 'ghcr.io/dork-labs/dorkos-community',
      checks: [{ name: 'health', status: 'passing' }],
    },
  ],
  releases: [
    {
      id: 'release-id',
      imageRef: `ghcr.io/dork-labs/dorkos-community@${plan.imageDigest}`,
      status: 'complete',
      stable: false,
      version: 1,
    },
  ],
  addresses: [{ id: 'address-id', address: '203.0.113.1', type: 'v4', region: '' }],
};

function harness(initial = journal()) {
  let persisted = initial;
  let inventory: FlySecretInventoryItem[] = [
    { name: 'AWS_ACCESS_KEY_ID', digest: 'aws-access', status: 'Deployed' as const },
    { name: 'AWS_SECRET_ACCESS_KEY', digest: 'aws-secret', status: 'Deployed' as const },
  ];
  const dependencies: CommunityDeployPhaseDependencies = {
    persist: vi.fn(async (next, revision) => {
      expect(revision).toBe(persisted.revision);
      persisted = LaunchJournalSchema.parse(next);
    }),
    readSecrets: vi.fn(async () => inventory),
    useDatabaseUrl: async (consumer) =>
      consumer('postgresql://role:secret@direct.example/db?sslmode=require'),
    stageSecrets: vi.fn(async (values) => {
      expect(Object.keys(values).sort()).toEqual(
        [
          'COMMUNITY_AUTH_SECRET',
          'COMMUNITY_BOOTSTRAP_SECRET',
          'COMMUNITY_DATABASE_URL',
          'COMMUNITY_INVITE_SECRET',
        ].sort()
      );
      inventory = [
        ...inventory,
        ...Object.keys(values).map((name, index) => ({
          name,
          digest: `digest-${index}`,
          status: 'Staged' as const,
        })),
      ];
    }),
    readRuntime: vi
      .fn()
      .mockResolvedValueOnce({ machines: [], releases: [], addresses: [] })
      .mockResolvedValue(runtime),
    deploy: vi.fn(async () => {
      inventory = inventory.map((item) =>
        item.status === 'Staged' ? { ...item, status: 'Deployed' as const } : item
      );
    }),
    verifyNewRuntime: vi.fn((value) => value),
    verifyExistingRuntime: vi.fn((value) => value),
    verifyHealth: vi.fn(),
    now: () => '2026-09-21T00:00:01.000Z',
  };
  return { dependencies, persisted: () => persisted, inventory: () => inventory };
}

describe('Community deploy phase', () => {
  it('stages generated secrets, proves digests, deploys, and records health', async () => {
    const test = harness();
    const result = await executeCommunityDeployPhase(plan, test.persisted(), test.dependencies);

    expect(test.dependencies.stageSecrets).toHaveBeenCalledOnce();
    expect(test.dependencies.deploy).toHaveBeenCalledWith(plan.imageDigest);
    expect(test.dependencies.verifyHealth).toHaveBeenCalledWith(
      'https://dorkos-community-test.fly.dev'
    );
    expect(result.bootstrapSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.journal).toMatchObject({
      state: 'healthy',
      resources: {
        flyMachineId: 'machine-id',
        flyReleaseId: 'release-id',
        flyAddressId: 'address-id',
      },
    });
    expect(JSON.stringify(result.journal)).not.toContain('postgresql://');
  });

  it('resumes after deployment readback without importing or deploying again', async () => {
    const secretDigests = Object.fromEntries(
      ['DATABASE', 'AUTH', 'INVITE', 'BOOTSTRAP'].map((part, index) => [
        `COMMUNITY_${part}${part === 'DATABASE' ? '_URL' : '_SECRET'}`,
        `digest-${index}`,
      ])
    );
    const staged = journal({
      revision: 7,
      state: 'secrets_staged',
      secretDigests,
      completedSteps: [
        'planned',
        'fly_app_created',
        'neon_project_created',
        'bucket_created',
        'secrets_staged',
      ],
    });
    const test = harness(staged);
    vi.mocked(test.dependencies.readSecrets).mockResolvedValue([
      ...test.inventory(),
      ...Object.entries(secretDigests).map(([name, digest]) => ({
        name,
        digest,
        status: 'Deployed' as const,
      })),
    ]);
    vi.mocked(test.dependencies.readRuntime).mockReset().mockResolvedValue(runtime);

    const result = await executeCommunityDeployPhase(plan, staged, test.dependencies);
    expect(test.dependencies.stageSecrets).not.toHaveBeenCalled();
    expect(test.dependencies.deploy).not.toHaveBeenCalled();
    expect(test.dependencies.verifyExistingRuntime).toHaveBeenCalledOnce();
    expect(result.bootstrapSecret).toBeNull();
  });

  it('adopts one fully staged secret set after a crash before journaling', async () => {
    const interrupted = journal({ secretBaseline: {} });
    const test = harness(interrupted);
    const staged = ['DATABASE', 'AUTH', 'INVITE', 'BOOTSTRAP'].map((part, index) => ({
      name: `COMMUNITY_${part}${part === 'DATABASE' ? '_URL' : '_SECRET'}`,
      digest: `fresh-${index}`,
      status: 'Staged' as const,
    }));
    vi.mocked(test.dependencies.readSecrets)
      .mockResolvedValueOnce([...test.inventory(), ...staged])
      .mockResolvedValueOnce([...test.inventory(), ...staged])
      .mockResolvedValueOnce([
        ...test.inventory(),
        ...staged.map((item) => ({ ...item, status: 'Deployed' as const })),
      ]);

    const result = await executeCommunityDeployPhase(plan, interrupted, test.dependencies);
    expect(test.dependencies.stageSecrets).not.toHaveBeenCalled();
    expect(result.bootstrapSecret).toBeNull();
    expect(result.journal.completedSteps).toContain('healthy');
  });

  it('stops uncertain rather than replacing unjournaled staged secrets', async () => {
    const test = harness();
    vi.mocked(test.dependencies.readSecrets).mockResolvedValue([
      ...test.inventory(),
      { name: 'COMMUNITY_AUTH_SECRET', digest: 'unknown-digest', status: 'Staged' },
    ]);

    await expect(
      executeCommunityDeployPhase(plan, test.persisted(), test.dependencies)
    ).rejects.toThrow('Runtime secrets exist without a proven journal checkpoint');
    expect(test.dependencies.stageSecrets).not.toHaveBeenCalled();
    expect(test.persisted().state).toBe('uncertain');
  });
});
