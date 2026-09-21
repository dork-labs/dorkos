import { describe, expect, it, vi } from 'vitest';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import {
  CommunityCreationUncertainError,
  executeCommunityCreationPhase,
  type CommunityCreationDependencies,
} from '../execute.js';
import { ProviderMutationError } from '../provider-mutation.js';

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
    revision: 0,
    planHash: 'b'.repeat(64),
    releaseDigest: plan.imageDigest,
    state: 'planned',
    pendingIntent: null,
    resources: {},
    verifiedBindings: [],
    completedSteps: ['planned'],
    lastSafeError: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...update,
  });
}

function dependencies() {
  let persisted = journal();
  const boundary = (id: string, organizationId: string, name: string, bindingId?: string) => ({
    create: vi.fn().mockResolvedValue({ id, organizationId, name, bindingId }),
    inspect: vi.fn().mockResolvedValue({ id, organizationId, name, bindingId }),
  });
  const value: CommunityCreationDependencies = {
    persist: vi.fn(async (next, expectedRevision) => {
      expect(expectedRevision).toBe(persisted.revision);
      persisted = LaunchJournalSchema.parse(next);
    }),
    fly: boundary('app-id', 'dork-labs', 'dorkos-community-test'),
    neon: boundary('project-id', 'org-dorian', 'dorkos-community-test'),
    tigris: boundary('bucket-id', 'dork-labs', 'dorkos-community-test', 'app-id'),
    now: () => '2026-09-21T00:00:01.000Z',
  };
  return { value, persisted: () => persisted };
}

describe('Community creation executor', () => {
  it('journals each intent before create and completes only after exact-ID inspection', async () => {
    const harness = dependencies();
    const events: string[] = [];
    vi.mocked(harness.value.persist).mockImplementation(async (next, expected) => {
      expect(expected).toBe(harness.persisted().revision);
      events.push(
        next.pendingIntent ? `intent:${next.pendingIntent.provider}` : `state:${next.state}`
      );
      Object.assign(harness.persisted(), LaunchJournalSchema.parse(next));
    });
    for (const boundary of [harness.value.fly, harness.value.neon, harness.value.tigris]) {
      vi.mocked(boundary.create).mockImplementation(async () => {
        events.push('create');
        return vi.mocked(boundary.inspect).getMockImplementation()!('ignored');
      });
    }

    const result = await executeCommunityCreationPhase(plan, harness.persisted(), harness.value);
    expect(events).toEqual([
      'intent:fly',
      'create',
      'intent:fly',
      'state:fly_app_created',
      'intent:neon',
      'create',
      'intent:neon',
      'state:neon_project_created',
      'intent:tigris',
      'create',
      'intent:tigris',
      'state:bucket_created',
    ]);
    expect(result.resources).toEqual({
      flyAppId: 'app-id',
      neonProjectId: 'project-id',
      tigrisBucketId: 'bucket-id',
    });
    expect(result.verifiedBindings).toEqual([
      { kind: 'bucket-to-app', sourceId: 'bucket-id', targetId: 'app-id' },
    ]);
  });

  it('never repeats a create when a crash left an unresolved intent', async () => {
    const harness = dependencies();
    const interrupted = journal({
      revision: 1,
      pendingIntent: {
        provider: 'fly',
        organizationId: 'dork-labs',
        resourceName: 'dorkos-community-test',
      },
    });

    await expect(executeCommunityCreationPhase(plan, interrupted, harness.value)).rejects.toEqual(
      new CommunityCreationUncertainError('fly')
    );
    expect(harness.value.fly.create).not.toHaveBeenCalled();
  });

  it('records an uncertain stop when create output or binding cannot be proved', async () => {
    const harness = dependencies();
    vi.mocked(harness.value.fly.create).mockRejectedValue(
      new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN')
    );

    await expect(
      executeCommunityCreationPhase(plan, harness.persisted(), harness.value)
    ).rejects.toEqual(new CommunityCreationUncertainError('fly'));
    expect(harness.persisted()).toMatchObject({
      state: 'uncertain',
      pendingIntent: { provider: 'fly' },
      lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
    });
  });

  it('refuses a bucket attached to any app other than the exact created app', async () => {
    const harness = dependencies();
    vi.mocked(harness.value.tigris.create).mockResolvedValue({
      id: 'bucket-id',
      organizationId: 'dork-labs',
      name: 'dorkos-community-test',
      bindingId: 'foreign-app',
    });

    await expect(
      executeCommunityCreationPhase(plan, harness.persisted(), harness.value)
    ).rejects.toEqual(new CommunityCreationUncertainError('tigris'));
    expect(harness.persisted()).toMatchObject({
      state: 'uncertain',
      pendingIntent: { provider: 'tigris' },
    });
  });

  it('clears a pre-request spawn failure so a deliberate resume may try again', async () => {
    const harness = dependencies();
    vi.mocked(harness.value.fly.create).mockRejectedValue(
      new ProviderMutationError('PROVIDER_UNAVAILABLE')
    );

    await expect(
      executeCommunityCreationPhase(plan, harness.persisted(), harness.value)
    ).rejects.toEqual(new ProviderMutationError('PROVIDER_UNAVAILABLE'));
    expect(harness.persisted()).toMatchObject({
      state: 'planned',
      pendingIntent: null,
      lastSafeError: { category: 'transient', code: 'PROVIDER_UNAVAILABLE' },
    });
  });

  it.each(['AUTH_REQUIRED', 'PROVIDER_UNAVAILABLE'])(
    'retains a returned identity when readback stops with %s so resume never creates twice',
    async (code) => {
      const harness = dependencies();
      vi.mocked(harness.value.fly.inspect).mockRejectedValue(
        Object.assign(new Error('safe readback failure'), { code })
      );

      await expect(
        executeCommunityCreationPhase(plan, harness.persisted(), harness.value)
      ).rejects.toEqual(new CommunityCreationUncertainError('fly'));
      expect(harness.persisted()).toMatchObject({
        state: 'uncertain',
        pendingIntent: { provider: 'fly' },
        resources: { flyAppId: 'app-id' },
        lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
      });

      await expect(
        executeCommunityCreationPhase(plan, harness.persisted(), harness.value)
      ).rejects.toEqual(new CommunityCreationUncertainError('fly'));
      expect(harness.value.fly.create).toHaveBeenCalledTimes(1);
      expect(harness.value.fly.inspect).toHaveBeenCalledTimes(2);
    }
  );

  it('rejects topology drift when rechecking a completed Neon project', async () => {
    const harness = dependencies();
    const completed = journal({
      state: 'neon_project_created',
      resources: {
        flyAppId: 'app-id',
        neonProjectId: 'project-id',
        neonBranchId: 'branch-id',
        neonDatabaseId: 'database-id',
        neonRoleId: 'role-id',
        neonEndpointId: 'endpoint-id',
      },
      verifiedBindings: [
        { kind: 'endpoint-to-project', sourceId: 'endpoint-id', targetId: 'project-id' },
      ],
      completedSteps: ['planned', 'fly_app_created', 'neon_project_created'],
    });
    vi.mocked(harness.value.neon.inspect).mockResolvedValue({
      id: 'project-id',
      organizationId: 'org-dorian',
      name: 'dorkos-community-test',
      relatedResources: {
        neonBranchId: 'branch-id',
        neonDatabaseId: 'database-id',
        neonRoleId: 'role-id',
        neonEndpointId: 'replacement-endpoint',
      },
      verifiedBindings: [
        {
          kind: 'endpoint-to-project',
          sourceId: 'replacement-endpoint',
          targetId: 'project-id',
        },
      ],
    });

    await expect(executeCommunityCreationPhase(plan, completed, harness.value)).rejects.toEqual(
      new ProviderMutationError('INVALID_RESPONSE')
    );
    expect(harness.value.neon.create).not.toHaveBeenCalled();
  });

  it('finishes separate Tigris terms consent before recording a bucket intent', async () => {
    const harness = dependencies();
    harness.value.tigris.prepare = vi.fn().mockRejectedValue(new Error('terms declined'));

    await expect(
      executeCommunityCreationPhase(plan, harness.persisted(), harness.value)
    ).rejects.toThrow('terms declined');
    expect(harness.value.tigris.create).not.toHaveBeenCalled();
    expect(harness.persisted()).toMatchObject({
      state: 'neon_project_created',
      pendingIntent: null,
      resources: { flyAppId: 'app-id', neonProjectId: 'project-id' },
    });
  });
});
