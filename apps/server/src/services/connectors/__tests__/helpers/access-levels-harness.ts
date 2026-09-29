/**
 * One real database, one app whose catalog a test can change between reads,
 * and (for a DorkOS account) a hosted authority whose answers a test decides:
 * the harness for the access-level tests (ADR 260929-071355).
 */
import { vi } from 'vitest';
import {
  and,
  connectionAccessLevels,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  createDb,
  eq,
  isNull,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorOperationClassification,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { EveryAgentActivitySink } from '../../every-agent-activity.js';
import { ConnectorReconciliationService } from '../../reconciliation-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { ManagedAuthoritySyncService } from '../../resources/managed-authority-sync-service.js';

export const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
export const NOW = new Date('2026-09-29T12:00:00.000Z');
export const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');

/** One action in the app's catalog, as the service describes it today. */
export interface CatalogAction {
  slug: string;
  classification: ConnectorOperationClassification;
}

/**
 * The hosted revision id of one action as classified today. Hosted authority
 * mints a new id when an action is reclassified, so the class is part of it.
 */
export function hostedRef(slug: string, classification: ConnectorOperationClassification): string {
  const n = [...`${slug}:${classification}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** How hosted authority answers the next command. */
export type HostedAnswer = 'applied' | 'pending' | 'rejected' | 'conflict' | 'unauthorized';

/** Everything one access-level test works with. */
export interface LevelHarness {
  db: Db;
  provider: FakeConnectorProvider;
  registry: ConnectorRegistry;
  /** The app's catalog; change it, then read it again. */
  catalog: CatalogAction[];
  /** Registered agents; change it to add or drop one. */
  agents: Array<{ agentId: string; displayName: string }>;
  service: ConnectorReconciliationService;
  activity: { emit: ReturnType<typeof vi.fn<EveryAgentActivitySink['emit']>> };
  /** Present on a DorkOS account. */
  sync?: ManagedAuthoritySyncService;
  /** Hosted commands sent, in order. */
  submitted: ManagedConnectorAuthorityCommand[];
  /** Sets how hosted authority answers from now on. */
  answer(next: HostedAnswer): void;
  /** Hosted authority finishes applying every command it holds as pending. */
  applyPending(): Promise<void>;
  /** Read the catalog as the owner opening "Who can use it?". */
  preview(): Promise<ConnectorReconciliationPreview>;
  /** Make the account a DorkOS account (a way moved to it), with hosted authority. */
  moveToDorkosAccount(): void;
}

/**
 * Build a harness.
 *
 * @param options - `managed` for a DorkOS account; `type` for the way's type.
 */
export function levelHarness(options: { managed?: boolean; type?: string } = {}): LevelHarness {
  const db = createDb(':memory:');
  runMigrations(db);
  const provider = new FakeConnectorProvider({
    instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
    type: options.type ?? 'fake',
    ...(options.managed ? { custody: 'managed' as const } : {}),
    toolkitVersion: 'v1',
  });
  const managed = options.managed === true;
  const catalog: CatalogAction[] = [
    { slug: 'gmail.list', classification: 'read' },
    { slug: 'gmail.send', classification: 'write' },
    { slug: 'gmail.delete', classification: 'destructive' },
  ];
  vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) => ({
    status: 'ok' as const,
    page: {
      operations: catalog.map((action) => ({
        providerInstanceId: provider.instanceId,
        toolkit: request.toolkit,
        operationSlug: action.slug,
        toolkitVersion: request.toolkitVersion,
        schemaHash: `sha256:${action.slug}`,
        capabilityClassification: action.classification,
        retryPolicy: 'never' as const,
        inputSchema: { type: 'object', additionalProperties: false },
        // The service's own revision id, the same whichever way reaches it.
        providerRevisionRef: hostedRef(action.slug, action.classification),
      })),
      truncated: false,
    },
  }));
  const registry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
  });
  registry.register(provider, 'material-a', managed ? 'managed' : 'byo');
  db.insert(connections)
    .values({
      id: CONNECTION_ID,
      providerInstanceId: provider.instanceId,
      externalAccountRef: 'external-a',
      toolkit: 'gmail',
      label: 'Work Gmail',
      status: 'active',
      lifecycleState: 'connected',
      enabled: true,
      grantReconciliationStatus: 'ready',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .run();

  const submitted: ManagedConnectorAuthorityCommand[] = [];
  let hosted: HostedAnswer = 'applied';
  const hostedStatus = new Map<string, ManagedConnectorAuthorityCommandStatus>();
  const statusFor = (
    command: ManagedConnectorAuthorityCommand,
    state: 'applied' | 'pending' | 'rejected'
  ): ManagedConnectorAuthorityCommandStatus => {
    const base = {
      version: 1 as const,
      commandId: command.commandId,
      managedConnectionId: command.managedConnectionId,
      scopeVersion: command.scopeVersion,
    };
    if (state === 'applied') return { ...base, state, externalCleanup: 'not_required' };
    if (state === 'rejected') return { ...base, state, rejectionCode: 'revision_unavailable' };
    return { ...base, state };
  };
  let nextManaged = 0;
  const makeSync = () =>
    new ManagedAuthoritySyncService({
      db,
      now: () => NOW,
      createId: () => `managed-${++nextManaged}`,
      cloud: {
        submitConnectorAuthorityCommand: async (command) => {
          // A conflict fails for good at the service; `unauthorized` is this
          // computer's link to the DorkOS account lapsing.
          if (hosted === 'conflict' || hosted === 'unauthorized') {
            throw Object.assign(new Error(hosted), { code: hosted });
          }
          submitted.push(command);
          const status = statusFor(command, hosted);
          hostedStatus.set(command.commandId, status);
          return status;
        },
        readConnectorAuthorityCommand: async (commandId) => {
          const status = hostedStatus.get(commandId);
          if (!status) throw Object.assign(new Error('absent'), { code: 'not_found' });
          return status;
        },
      },
    });

  const agents = [
    { agentId: 'reader', displayName: 'Reader' },
    { agentId: 'writer', displayName: 'Writer' },
    { agentId: 'exact', displayName: 'Exact' },
  ];
  const activity = { emit: vi.fn<EveryAgentActivitySink['emit']>() };
  let nextId = 0;
  const makeService = (sync?: ManagedAuthoritySyncService) =>
    new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => agents,
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      activity,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
      ...(sync ? { managedAuthority: sync } : {}),
    });

  const harness: LevelHarness = {
    db,
    provider,
    registry,
    catalog,
    agents,
    activity,
    submitted,
    sync: managed ? makeSync() : undefined,
    service: undefined as unknown as ConnectorReconciliationService,
    answer(next) {
      hosted = next;
    },
    async applyPending() {
      for (const command of submitted) {
        if (hostedStatus.get(command.commandId)?.state !== 'pending') continue;
        hostedStatus.set(command.commandId, statusFor(command, 'applied'));
        db.update(connectorManagedAuthorityOutbox)
          .set({ nextAttemptAt: null })
          .where(eq(connectorManagedAuthorityOutbox.commandId, command.commandId))
          .run();
      }
      await harness.sync!.recoverPending(new AbortController().signal);
    },
    preview() {
      return harness.service.preview(
        OWNER,
        { connectionId: CONNECTION_ID },
        new AbortController().signal
      );
    },
    moveToDorkosAccount() {
      registry.register(provider, 'material-a', 'managed');
      harness.sync = makeSync();
      harness.service = makeService(harness.sync);
    },
  };
  harness.service = makeService(harness.sync);
  return harness;
}

/** What one subject can use right now, by action name and class. */
export function liveActions(db: Db, subject: { agentId: string } | 'every_agent'): string[] {
  return db
    .select({
      slug: connectorOperationRevisions.operationSlug,
      classification: connectorOperationRevisions.capabilityClassification,
    })
    .from(connectionOperationGrants)
    .innerJoin(
      connectorOperationRevisions,
      eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
    )
    .where(
      and(
        eq(connectionOperationGrants.connectionId, CONNECTION_ID),
        subject === 'every_agent'
          ? eq(connectionOperationGrants.subjectType, 'every_agent')
          : eq(connectionOperationGrants.subjectId, subject.agentId),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .all()
    .map((row) => `${row.slug}:${row.classification}`)
    .sort();
}

/** The subjects that hold a level now, as `subject:level`. */
export function storedLevels(db: Db): string[] {
  return db
    .select()
    .from(connectionAccessLevels)
    .all()
    .map((row) => `${row.subjectId}:${row.level}`)
    .sort();
}

/** The exact revisions a level covers in one snapshot (the rule, restated). */
export function levelIds(snapshot: ConnectorReconciliationPreview, level: 'read' | 'read-write') {
  return snapshot.candidates
    .filter(
      (candidate) =>
        candidate.supported &&
        (candidate.capabilityClassification === 'read' ||
          (level === 'read-write' && candidate.capabilityClassification === 'write'))
    )
    .map((candidate) => candidate.operationRevisionId)
    .sort();
}

/** The one offered revision of an action in a snapshot. */
export function idOf(snapshot: ConnectorReconciliationPreview, slug: string): string {
  const candidate = snapshot.candidates.find(
    (entry) => entry.operationSlug === slug && entry.supported
  );
  if (!candidate) throw new Error(`No offered ${slug} in the preview.`);
  return candidate.operationRevisionId;
}

/** Give Reader Read, Writer Read and write, and Exact the list action by hand. */
export async function grantLevels(harness: LevelHarness): Promise<ConnectorReconciliationPreview> {
  const snapshot = await harness.preview();
  await harness.service.apply(OWNER, {
    previewId: snapshot.previewId,
    grants: [
      { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      {
        agentId: 'writer',
        operationRevisionIds: levelIds(snapshot, 'read-write'),
        level: 'read-write',
      },
      { agentId: 'exact', operationRevisionIds: [idOf(snapshot, 'gmail.list')] },
    ],
  });
  return snapshot;
}
