/**
 * Resumable creation phase for a Community launch.
 *
 * @module commands/community-deploy/execute
 */
import type { LaunchJournal } from './journal.js';
import type { LaunchPlan } from './plan.js';
import { ProviderMutationError } from './provider-mutation.js';

type CreationService = 'fly' | 'neon' | 'tigris';
type CreatedState = 'fly_app_created' | 'neon_project_created' | 'bucket_created';
type ResourceKey = 'flyAppId' | 'neonProjectId' | 'tigrisBucketId';

/** Non-secret identity returned by a create call and exact-ID readback. */
export interface CreatedResourceIdentity {
  /** Service-issued immutable identity. */
  id: string;
  /** Organization selected in the immutable plan. */
  organizationId: string;
  /** Planned resource name or label. */
  name: string;
  /** Exact parent identity when this resource is attached to another resource. */
  bindingId?: string;
  /** Additional exact identities proven during the same readback. */
  relatedResources?: Partial<LaunchJournal['resources']>;
  /** Additional non-secret bindings proven during the same readback. */
  verifiedBindings?: LaunchJournal['verifiedBindings'];
}

/** One creation boundary with exact-identity readback. */
export interface CreationBoundary {
  /** Submit one create request. */
  create(): Promise<CreatedResourceIdentity>;
  /** Read the returned exact identity and reject any binding drift. */
  inspect(id: string): Promise<CreatedResourceIdentity>;
}

/** Journal and service boundaries for the first provisioning phase. */
export interface CommunityCreationDependencies {
  /** Persist one complete next journal revision durably. */
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  /** Fly app create and exact-ID readback. */
  fly: CreationBoundary;
  /** Neon project create and exact-ID readback. */
  neon: CreationBoundary;
  /** Private Tigris bucket create and exact-ID readback. */
  tigris: CreationBoundary;
  /** Clock used only for journal timestamps. */
  now(): string;
}

/** Durable stop when a prior create may have succeeded without provable identity. */
export class CommunityCreationUncertainError extends Error {
  /** Service whose ownership requires manual reconciliation. */
  readonly service: CreationService;

  /** Create a secret-free uncertain stop. */
  constructor(service: CreationService) {
    super(`Community creation outcome requires manual reconciliation (${service})`);
    this.name = 'CommunityCreationUncertainError';
    this.service = service;
  }
}

interface CreationStep {
  service: CreationService;
  state: CreatedState;
  resourceKey: ResourceKey;
  organizationId: string;
  resourceName: string;
  expectedBindingResourceKey?: ResourceKey;
  boundary: CreationBoundary;
}

function withRevision(
  journal: LaunchJournal,
  now: string,
  update: Partial<LaunchJournal>
): LaunchJournal {
  return {
    ...journal,
    ...update,
    revision: journal.revision + 1,
    updatedAt: now,
  };
}

function assertIdentity(
  step: CreationStep,
  identity: CreatedResourceIdentity,
  expectedBindingId: string | undefined
): void {
  if (
    identity.organizationId !== step.organizationId ||
    identity.name !== step.resourceName ||
    identity.id.length === 0 ||
    (expectedBindingId !== undefined && identity.bindingId !== expectedBindingId) ||
    (identity.relatedResources !== undefined &&
      Object.values(identity.relatedResources).some((value) => !value))
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
}

async function persistNext(
  dependencies: CommunityCreationDependencies,
  current: LaunchJournal,
  update: Partial<LaunchJournal>
): Promise<LaunchJournal> {
  const next = withRevision(current, dependencies.now(), update);
  await dependencies.persist(next, current.revision);
  return next;
}

async function executeCreationStep(
  journal: LaunchJournal,
  step: CreationStep,
  dependencies: CommunityCreationDependencies
): Promise<LaunchJournal> {
  const existingId = journal.resources[step.resourceKey];
  const expectedBindingId = step.expectedBindingResourceKey
    ? journal.resources[step.expectedBindingResourceKey]
    : undefined;
  if (step.expectedBindingResourceKey && !expectedBindingId) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  if (journal.completedSteps.includes(step.state)) {
    if (!existingId) throw new ProviderMutationError('INVALID_RESPONSE');
    const inspected = await step.boundary.inspect(existingId);
    assertIdentity(step, inspected, expectedBindingId);
    return journal;
  }
  if (journal.pendingIntent) {
    throw new CommunityCreationUncertainError(journal.pendingIntent.provider);
  }

  const current = await persistNext(dependencies, journal, {
    pendingIntent: {
      provider: step.service,
      organizationId: step.organizationId,
      resourceName: step.resourceName,
    },
    lastSafeError: null,
  });

  let created: CreatedResourceIdentity;
  try {
    created = await step.boundary.create();
    assertIdentity(step, created, expectedBindingId);
    const inspected = await step.boundary.inspect(created.id);
    assertIdentity(step, inspected, expectedBindingId);
    if (inspected.id !== created.id) throw new ProviderMutationError('INVALID_RESPONSE');
    if (
      JSON.stringify(inspected.relatedResources ?? {}) !==
      JSON.stringify(created.relatedResources ?? {})
    ) {
      throw new ProviderMutationError('INVALID_RESPONSE');
    }
  } catch (error) {
    const safeCode =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null;
    if (
      safeCode === 'PROVIDER_UNAVAILABLE' ||
      safeCode === 'AUTH_REQUIRED' ||
      safeCode === 'ACCESS_DENIED' ||
      safeCode === 'TERMS_NOT_ACCEPTED'
    ) {
      const category =
        safeCode === 'AUTH_REQUIRED'
          ? 'authentication'
          : safeCode === 'ACCESS_DENIED' || safeCode === 'TERMS_NOT_ACCEPTED'
            ? 'authorization'
            : 'transient';
      await persistNext(dependencies, current, {
        pendingIntent: null,
        lastSafeError: { category, code: safeCode },
      });
      throw error;
    }
    await persistNext(dependencies, current, {
      state: 'uncertain',
      lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
    });
    throw new CommunityCreationUncertainError(step.service);
  }

  return persistNext(dependencies, current, {
    state: step.state,
    pendingIntent: null,
    resources: {
      ...current.resources,
      [step.resourceKey]: created.id,
      ...(created.relatedResources ?? {}),
    },
    verifiedBindings: [
      ...current.verifiedBindings,
      ...(expectedBindingId === undefined
        ? []
        : [{ kind: 'bucket-to-app' as const, sourceId: created.id, targetId: expectedBindingId }]),
      ...(created.verifiedBindings ?? []),
    ],
    completedSteps: [...current.completedSteps, step.state],
    lastSafeError: null,
  });
}

/**
 * Create and prove the Fly app, Neon project, and private bucket in journal order.
 *
 * A pending creation intent without a recorded service identity always stops for manual
 * reconciliation. A name match is never treated as provenance and a create is never repeated blindly.
 *
 * @param plan - Immutable consented launch plan.
 * @param journal - Latest durable journal revision.
 * @param dependencies - Journal and exact-identity service boundaries.
 * @returns Latest journal after all three creation checkpoints are proved.
 */
export async function executeCommunityCreationPhase(
  plan: LaunchPlan,
  journal: LaunchJournal,
  dependencies: CommunityCreationDependencies
): Promise<LaunchJournal> {
  let current = journal;
  const steps: CreationStep[] = [
    {
      service: 'fly',
      state: 'fly_app_created',
      resourceKey: 'flyAppId',
      organizationId: plan.fly.organizationId,
      resourceName: plan.fly.appName,
      boundary: dependencies.fly,
    },
    {
      service: 'neon',
      state: 'neon_project_created',
      resourceKey: 'neonProjectId',
      organizationId: plan.neon.organizationId,
      resourceName: plan.neon.projectName,
      boundary: dependencies.neon,
    },
    {
      service: 'tigris',
      state: 'bucket_created',
      resourceKey: 'tigrisBucketId',
      organizationId: plan.fly.organizationId,
      resourceName: plan.tigris.bucketName,
      expectedBindingResourceKey: 'flyAppId',
      boundary: dependencies.tigris,
    },
  ];
  for (const step of steps) current = await executeCreationStep(current, step, dependencies);
  return current;
}
