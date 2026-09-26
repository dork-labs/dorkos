/**
 * Resumable creation phase for a Community launch.
 *
 * @module commands/community-deploy/execute
 */
import { ProvenanceMarkerSchema, type LaunchJournal } from './journal.js';
import type { LaunchPlan } from './plan.js';
import { createProvenanceMarker } from './provenance/provenance-gate.js';
import { ProviderMutationError } from './provider-mutation.js';

type CreationService = 'fly' | 'neon' | 'tigris';
type CreatedState = 'fly_app_created' | 'neon_project_created' | 'bucket_created';
type ResourceKey = 'flyAppId' | 'neonProjectId' | 'tigrisBucketId';

/** Non-secret identity returned by a create response or exact-ID readback. */
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
  /** Provenance values exactly as the service reported them in this readback. */
  provenance?: NonNullable<LaunchJournal['provenance']>;
}

/** What an exact-ID readback may check besides the identity itself. */
export interface CreationInspectContext {
  /** Journal revision the readback runs against. */
  journal: LaunchJournal;
  /**
   * Marker recorded with this step's own creation intent. Absent once the step has completed, and
   * on an intent written before markers shipped.
   */
  provenanceMarker?: string;
}

/** One creation boundary with exact-identity readback. */
export interface CreationBoundary {
  /** Complete any read-only prerequisites before a creation intent is recorded. */
  prepare?(): Promise<void>;
  /** Submit one create request carrying the marker already recorded with its intent. */
  create(provenanceMarker: string): Promise<CreatedResourceIdentity>;
  /** Read the returned exact identity and reject any binding or provenance drift. */
  inspect(id: string, context: CreationInspectContext): Promise<CreatedResourceIdentity>;
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
  /** Render the current secret-free service step before it may block. */
  progress?(service: CreationService): void;
  /** Marker source for each creation intent; defaults to 128 random bits. */
  createProvenanceMarker?(): string;
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
  relatedResourceKeys?: readonly (keyof LaunchJournal['resources'])[];
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
    const inspected = await step.boundary.inspect(existingId, { journal });
    assertIdentity(step, inspected, expectedBindingId);
    assertJournalIdentity(journal, step, inspected, expectedBindingId);
    return journal;
  }
  if (journal.pendingIntent && (!existingId || journal.pendingIntent.provider !== step.service)) {
    throw new CommunityCreationUncertainError(journal.pendingIntent.provider);
  }

  let current = journal;
  let createdId = existingId;
  if (!journal.pendingIntent) {
    await step.boundary.prepare?.();
    const provenanceMarker = ProvenanceMarkerSchema.parse(
      (dependencies.createProvenanceMarker ?? createProvenanceMarker)()
    );
    // The marker and request time are durable before any provider request, so a create whose
    // outcome is lost can still be matched to this run later.
    current = await persistNext(dependencies, journal, {
      pendingIntent: {
        provider: step.service,
        organizationId: step.organizationId,
        resourceName: step.resourceName,
        provenanceMarker,
        requestedAt: dependencies.now(),
      },
      lastSafeError: null,
    });

    let created: CreatedResourceIdentity;
    try {
      created = await step.boundary.create(provenanceMarker);
      assertIdentity(step, created, expectedBindingId);
    } catch (error) {
      const safeCode = safeErrorCode(error);
      if (isCertifiedPreSubmitFailure(safeCode)) {
        await persistNext(dependencies, current, {
          pendingIntent: null,
          lastSafeError: { category: safeErrorCategory(safeCode), code: safeCode },
        });
        throw error;
      }
      await persistUncertain(dependencies, current);
      throw new CommunityCreationUncertainError(step.service);
    }
    createdId = created.id;
    current = await persistNext(dependencies, current, {
      resources: { ...current.resources, [step.resourceKey]: createdId },
    });
  }

  const provenanceMarker = current.pendingIntent?.provenanceMarker;
  let inspected: CreatedResourceIdentity;
  try {
    inspected = await step.boundary.inspect(createdId!, { journal: current, provenanceMarker });
    assertIdentity(step, inspected, expectedBindingId);
    if (inspected.id !== createdId) throw new ProviderMutationError('INVALID_RESPONSE');
    if (step.service === 'fly' && provenanceMarker && !inspected.provenance?.flyNetwork) {
      throw new ProviderMutationError('INVALID_RESPONSE');
    }
  } catch {
    await persistUncertain(dependencies, current);
    throw new CommunityCreationUncertainError(step.service);
  }

  // Only the Fly step reads provenance back; it is stored as read, never derived from the intent.
  const flyNetwork = step.service === 'fly' ? inspected.provenance?.flyNetwork : undefined;
  return persistNext(dependencies, current, {
    state: step.state,
    pendingIntent: null,
    ...(flyNetwork === undefined ? {} : { provenance: { ...current.provenance, flyNetwork } }),
    resources: {
      ...current.resources,
      [step.resourceKey]: inspected.id,
      ...(inspected.relatedResources ?? {}),
    },
    verifiedBindings: [
      ...current.verifiedBindings,
      ...(expectedBindingId === undefined
        ? []
        : [
            { kind: 'bucket-to-app' as const, sourceId: inspected.id, targetId: expectedBindingId },
          ]),
      ...(inspected.verifiedBindings ?? []),
    ],
    completedSteps: [...current.completedSteps, step.state],
    lastSafeError: null,
  });
}

function safeErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function isCertifiedPreSubmitFailure(
  code: string | null
): code is 'PROVIDER_UNAVAILABLE' | 'AUTH_REQUIRED' | 'ACCESS_DENIED' | 'TERMS_NOT_ACCEPTED' {
  return (
    code === 'PROVIDER_UNAVAILABLE' ||
    code === 'AUTH_REQUIRED' ||
    code === 'ACCESS_DENIED' ||
    code === 'TERMS_NOT_ACCEPTED'
  );
}

function safeErrorCategory(code: ReturnType<typeof safeErrorCode>) {
  return code === 'AUTH_REQUIRED'
    ? ('authentication' as const)
    : code === 'ACCESS_DENIED' || code === 'TERMS_NOT_ACCEPTED'
      ? ('authorization' as const)
      : ('transient' as const);
}

async function persistUncertain(
  dependencies: CommunityCreationDependencies,
  current: LaunchJournal
): Promise<void> {
  await persistNext(dependencies, current, {
    state: 'uncertain',
    lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
  });
}

function assertJournalIdentity(
  journal: LaunchJournal,
  step: CreationStep,
  inspected: CreatedResourceIdentity,
  expectedBindingId: string | undefined
): void {
  if (inspected.id !== journal.resources[step.resourceKey]) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  const journaledNetwork = journal.provenance?.flyNetwork;
  if (
    step.service === 'fly' &&
    journaledNetwork !== undefined &&
    inspected.provenance?.flyNetwork !== journaledNetwork
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  for (const key of step.relatedResourceKeys ?? []) {
    if (!inspected.relatedResources || inspected.relatedResources[key] !== journal.resources[key]) {
      throw new ProviderMutationError('INVALID_RESPONSE');
    }
  }
  const expectedBindings = [
    ...(expectedBindingId === undefined
      ? []
      : [{ kind: 'bucket-to-app' as const, sourceId: inspected.id, targetId: expectedBindingId }]),
    ...(inspected.verifiedBindings ?? []),
  ];
  for (const expected of expectedBindings) {
    if (
      !journal.verifiedBindings.some(
        (binding) => JSON.stringify(binding) === JSON.stringify(expected)
      )
    ) {
      throw new ProviderMutationError('INVALID_RESPONSE');
    }
  }
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
      relatedResourceKeys: ['neonBranchId', 'neonDatabaseId', 'neonRoleId', 'neonEndpointId'],
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
  for (const step of steps) {
    dependencies.progress?.(step.service);
    current = await executeCreationStep(current, step, dependencies);
  }
  return current;
}
