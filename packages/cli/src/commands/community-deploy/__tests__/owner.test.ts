import { describe, expect, it, vi } from 'vitest';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { executeCommunityOwnerHandoff, type CommunityOwnerDependencies } from '../owner.js';
import { createLaunchPlan } from '../plan.js';

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
    revision: 9,
    planHash: 'b'.repeat(64),
    releaseDigest: plan.imageDigest,
    state: 'healthy',
    pendingIntent: null,
    resources: {
      flyAppId: 'app-id',
      flyReleaseId: 'release-id',
      flyMachineId: 'machine-id',
      flyAddressId: 'address-id',
      neonProjectId: 'project-id',
      neonBranchId: 'branch-id',
      neonDatabaseId: 'database-id',
      neonRoleId: 'community_owner',
      neonEndpointId: 'endpoint-id',
      tigrisBucketId: 'bucket-id',
    },
    secretDigests: {
      COMMUNITY_DATABASE_URL: 'database-digest',
      COMMUNITY_AUTH_SECRET: 'auth-digest',
      COMMUNITY_INVITE_SECRET: 'invite-digest',
      COMMUNITY_BOOTSTRAP_SECRET: 'bootstrap-old',
    },
    verifiedBindings: [],
    completedSteps: [
      'planned',
      'fly_app_created',
      'neon_project_created',
      'bucket_created',
      'secrets_staged',
      'deployed',
      'healthy',
    ],
    lastSafeError: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...update,
  });
}

function harness(initial = journal()) {
  let persisted = initial;
  let digest = initial.secretDigests!.COMMUNITY_BOOTSTRAP_SECRET!;
  let posture: 'Staged' | 'Deployed' = 'Deployed';
  const dependencies: CommunityOwnerDependencies = {
    persist: vi.fn(async (next, revision) => {
      expect(revision).toBe(persisted.revision);
      persisted = LaunchJournalSchema.parse(next);
    }),
    stageBootstrap: vi.fn(async () => {
      digest = `${digest}-next`;
      posture = 'Staged';
    }),
    deploySecrets: vi.fn(async () => {
      posture = 'Deployed';
    }),
    readSecrets: vi.fn(async () => [
      { name: 'COMMUNITY_BOOTSTRAP_SECRET', digest, status: posture },
    ]),
    verifyRuntimeAndHealth: vi.fn(),
    handoffSecret: vi.fn(),
    ownerExists: vi.fn().mockResolvedValue(false),
    waitForOwnerClaim: vi.fn().mockResolvedValue(true),
    confirmAcceptance: vi.fn().mockResolvedValue(true),
    now: () => '2026-09-21T00:00:01.000Z',
  };
  return { dependencies, persisted: () => persisted };
}

describe('Community owner handoff', () => {
  it('hands off the uninterrupted secret, detects claim, rotates, and completes', async () => {
    const test = harness();
    const result = await executeCommunityOwnerHandoff(
      plan,
      test.persisted(),
      'initial-bootstrap-secret',
      test.dependencies
    );
    expect(test.dependencies.handoffSecret).toHaveBeenCalledWith(
      'https://dorkos-community-test.fly.dev',
      'initial-bootstrap-secret'
    );
    expect(test.dependencies.stageBootstrap).toHaveBeenCalledOnce();
    expect(test.dependencies.deploySecrets).toHaveBeenCalledOnce();
    expect(test.dependencies.verifyRuntimeAndHealth).toHaveBeenCalledOnce();
    expect(result.state).toBe('complete');
  });

  it('replaces and applies a lost setup secret before offering it again', async () => {
    const initial = journal({
      state: 'owner_pending',
      completedSteps: [...journal().completedSteps, 'owner_pending'],
    });
    const test = harness(initial);
    const result = await executeCommunityOwnerHandoff(plan, initial, null, test.dependencies);
    expect(test.dependencies.stageBootstrap).toHaveBeenCalledTimes(2);
    expect(test.dependencies.deploySecrets).toHaveBeenCalledTimes(2);
    expect(test.dependencies.handoffSecret).toHaveBeenCalledOnce();
    expect(result.state).toBe('complete');
  });

  it('stays owner-pending until both owner and meaningful behavior are confirmed', async () => {
    const test = harness();
    vi.mocked(test.dependencies.waitForOwnerClaim).mockResolvedValue(false);
    const pending = await executeCommunityOwnerHandoff(
      plan,
      test.persisted(),
      'initial-bootstrap-secret',
      test.dependencies
    );
    expect(pending.state).toBe('owner_pending');
    expect(test.dependencies.stageBootstrap).not.toHaveBeenCalled();
  });

  it('does not rotate or prompt again after completion', async () => {
    const complete = journal({
      state: 'complete',
      completedSteps: [...journal().completedSteps, 'owner_pending', 'complete'],
    });
    const test = harness(complete);
    await expect(
      executeCommunityOwnerHandoff(plan, complete, null, test.dependencies)
    ).resolves.toEqual(complete);
    expect(test.dependencies.stageBootstrap).not.toHaveBeenCalled();
    expect(test.dependencies.handoffSecret).not.toHaveBeenCalled();
  });

  it('does not repeat the post-claim rotation while acceptance is pending', async () => {
    const initial = journal({
      state: 'owner_pending',
      completedSteps: [...journal().completedSteps, 'owner_pending'],
    });
    const first = harness(initial);
    vi.mocked(first.dependencies.ownerExists).mockResolvedValue(true);
    vi.mocked(first.dependencies.confirmAcceptance).mockResolvedValue(false);
    const pending = await executeCommunityOwnerHandoff(plan, initial, null, first.dependencies);
    expect(pending.ownerBootstrapRotated).toBe(true);
    expect(first.dependencies.stageBootstrap).toHaveBeenCalledOnce();

    const resumed = harness(pending);
    vi.mocked(resumed.dependencies.ownerExists).mockResolvedValue(true);
    await executeCommunityOwnerHandoff(plan, pending, null, resumed.dependencies);
    expect(resumed.dependencies.stageBootstrap).not.toHaveBeenCalled();
  });
});
