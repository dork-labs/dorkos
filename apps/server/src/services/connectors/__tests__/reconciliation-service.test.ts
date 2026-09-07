/** Complete snapshots, named-agent replacement, and stale-preview refusal. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReconciliationPreviews,
  createDb,
  eq,
  isNull,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../registry.js';
import {
  ConnectorReconciliationError,
  ConnectorReconciliationService,
} from '../reconciliation-service.js';
import { ManagedAuthoritySyncService } from '../resources/managed-authority-sync-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-09-06T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');

describe('ConnectorReconciliationService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let service: ConnectorReconciliationService;
  let nextId: number;
  let agents: Array<{ agentId: string; displayName: string }>;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      toolkitVersion: 'current-v2',
    });
    registry = new ConnectorRegistry({ db });
    registry.register(provider, 'material-a');
    db.update(connectorProviderInstances)
      .set({ ownerKind: 'local_install', ownerId: OWNER.installationId })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
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
        grantReconciliationStatus: 'migration_needs_reconcile',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'old-read-v1',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: 'old-v1',
        schemaHash: 'sha256:fake-read-v1',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values(
        ['agent-a', 'agent-b'].map((agentId) => ({
          id: `grant-${agentId}`,
          subjectType: 'agent' as const,
          subjectId: agentId,
          agentId,
          connectionId: CONNECTION_ID,
          operationRevisionId: 'old-read-v1',
          createdBy: 'operator',
          createdAt: NOW.toISOString(),
        }))
      )
      .run();
    nextId = 0;
    agents = [
      { agentId: 'agent-a', displayName: 'Alpha' },
      { agentId: 'agent-b', displayName: 'Beta' },
    ];
    service = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => agents,
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      pageSize: 10,
    });
  });

  it('discloses preserved old grants beside every page of newly discovered revisions', async () => {
    const preview = await service.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );

    expect(preview.catalogComplete).toBe(true);
    expect(preview.agents).toEqual([
      { agentId: 'agent-a', displayName: 'Alpha' },
      { agentId: 'agent-b', displayName: 'Beta' },
    ]);
    expect(preview.candidates.map((candidate) => candidate.operationRevisionId).sort()).toEqual([
      'generated-2',
      'generated-3',
      'old-read-v1',
    ]);
    expect(preview.currentGrants).toEqual([
      { agentId: 'agent-a', operationRevisionIds: ['old-read-v1'] },
      { agentId: 'agent-b', operationRevisionIds: ['old-read-v1'] },
    ]);
    expect(
      preview.candidates.find((candidate) => candidate.operationRevisionId === 'old-read-v1')
    ).toMatchObject({ toolkitVersion: 'old-v1', supported: true });

    const newRead = preview.candidates.find(
      (candidate) =>
        candidate.operationSlug === 'gmail.read' && candidate.toolkitVersion === 'current-v2'
    )!;
    const applied = await service.apply(OWNER, {
      previewId: preview.previewId,
      grants: [
        {
          agentId: 'agent-a',
          operationRevisionIds: ['old-read-v1', newRead.operationRevisionId],
        },
      ],
    });

    expect(applied.grants).toHaveLength(1);
    const active = db
      .select({
        agentId: connectionOperationGrants.subjectId,
        operationRevisionId: connectionOperationGrants.operationRevisionId,
      })
      .from(connectionOperationGrants)
      .where(isNull(connectionOperationGrants.revokedAt))
      .all();
    expect(active).toEqual(
      expect.arrayContaining([
        { agentId: 'agent-a', operationRevisionId: 'old-read-v1' },
        { agentId: 'agent-a', operationRevisionId: newRead.operationRevisionId },
        { agentId: 'agent-b', operationRevisionId: 'old-read-v1' },
      ])
    );
    expect(db.select().from(connections).get()!.grantReconciliationStatus).toBe('ready');
  });

  it('never resurrects a prior local grant when a hosted classification returns to its old value', async () => {
    const originalDiscovery = provider.listOperationSchemas.bind(provider);
    let generation = 1;
    vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) => {
      const result = await originalDiscovery(request);
      if (result.status === 'ok')
        result.page.operations = result.page.operations.map((operation) => ({
          ...operation,
          ...(operation.operationSlug === 'gmail.read'
            ? {
                providerRevisionRef: `10000000-0000-4000-8000-00000000000${generation}`,
                capabilityClassification: generation === 2 ? ('write' as const) : ('read' as const),
              }
            : {}),
        }));
      return result;
    });
    const preview = () =>
      service.preview(OWNER, { connectionId: CONNECTION_ID }, new AbortController().signal);
    const first = await preview();
    const firstRead = first.candidates.find(
      (candidate) =>
        candidate.operationSlug === 'gmail.read' && candidate.toolkitVersion === 'current-v2'
    )!;
    await service.apply(OWNER, {
      previewId: first.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: [firstRead.operationRevisionId] }],
    });
    generation = 2;
    const second = await preview();
    const changed = second.candidates.find(
      (candidate) => candidate.operationSlug === 'gmail.read' && candidate.supported
    )!;
    expect(changed.operationRevisionId).not.toBe(firstRead.operationRevisionId);
    expect(changed.capabilityClassification).toBe('write');
    generation = 3;
    const third = await preview();
    const returned = third.candidates.find(
      (candidate) => candidate.operationSlug === 'gmail.read' && candidate.supported
    )!;
    expect(returned.capabilityClassification).toBe('read');
    expect(returned.operationRevisionId).not.toBe(firstRead.operationRevisionId);
    expect(returned.operationRevisionId).not.toBe(changed.operationRevisionId);
    expect(
      third.candidates.find(
        (candidate) => candidate.operationRevisionId === firstRead.operationRevisionId
      )?.supported
    ).toBe(false);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.operationRevisionId, returned.operationRevisionId))
        .all()
    ).toEqual([]);
    expect(JSON.stringify(third)).not.toContain('providerRevisionRef');
    expect(JSON.stringify(third)).not.toContain('10000000-0000-4000-8000-000000000003');
  });

  it('keeps managed additions inactive until the current hosted acknowledgement', async () => {
    const readRef = '10000000-0000-4000-8000-000000000001';
    const writeRef = '10000000-0000-4000-8000-000000000002';
    const originalDiscovery = provider.listOperationSchemas.bind(provider);
    vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) => {
      const result = await originalDiscovery(request);
      if (result.status === 'ok')
        result.page.operations = result.page.operations.map((operation) => ({
          ...operation,
          providerRevisionRef: operation.operationSlug === 'gmail.read' ? readRef : writeRef,
        }));
      return result;
    });
    // Model a previously reviewed hosted identity, not an unbound legacy revision.
    const oldRevision = db
      .select()
      .from(connectorOperationRevisions)
      .where(eq(connectorOperationRevisions.id, 'old-read-v1'))
      .get()!;
    db.insert(connectorOperationRevisions)
      .values({ ...oldRevision, id: 'managed-old-read-v1', providerRevisionRef: readRef })
      .run();
    db.update(connectionOperationGrants)
      .set({ operationRevisionId: 'managed-old-read-v1' })
      .where(eq(connectionOperationGrants.operationRevisionId, 'old-read-v1'))
      .run();

    db.update(connectorProviderInstances)
      .set({ mode: 'managed', custody: 'managed' })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    let release!: (status: ManagedConnectorAuthorityCommandStatus) => void;
    let submittedCommand: ManagedConnectorAuthorityCommand | undefined;
    const managedAuthority = new ManagedAuthoritySyncService({
      db,
      cloud: {
        submitConnectorAuthorityCommand: (command) =>
          new Promise((resolve) => {
            submittedCommand = command;
            release = resolve;
          }),
        readConnectorAuthorityCommand: async () => {
          throw Object.assign(new Error('absent'), { code: 'not_found' });
        },
      },
      now: () => NOW,
      createId: (() => {
        let id = 0;
        return () => `managed-${++id}`;
      })(),
    });
    service = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => agents,
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      pageSize: 10,
      managedAuthority,
    });
    const preview = await service.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    const addition = preview.candidates.find(
      (candidate) => candidate.operationSlug === 'gmail.write'
    )!;

    const applying = service.apply(OWNER, {
      previewId: preview.previewId,
      grants: [
        {
          agentId: 'agent-a',
          operationRevisionIds: ['managed-old-read-v1', addition.operationRevisionId],
        },
      ],
    });

    expect(db.select().from(connectorManagedAuthorityOutbox).get()?.state).toBe('pending');
    const grantsBeforeAck = db
      .select()
      .from(connectionOperationGrants)
      .where(eq(connectionOperationGrants.subjectId, 'agent-a'))
      .all();
    expect(
      grantsBeforeAck.find((grant) => grant.operationRevisionId === 'managed-old-read-v1')
        ?.revokedAt
    ).toBeNull();
    expect(
      grantsBeforeAck.find((grant) => grant.operationRevisionId === addition.operationRevisionId)
        ?.revokedAt
    ).toBe(NOW.toISOString());
    expect(db.select().from(connections).get()?.grantReconciliationStatus).toBe(
      'migration_needs_reconcile'
    );

    const command = submittedCommand!;
    release({
      version: 1,
      commandId: command.commandId,
      managedConnectionId: command.managedConnectionId,
      scopeVersion: command.scopeVersion,
      state: 'applied',
      externalCleanup: 'not_required',
    });
    await expect(applying).resolves.toMatchObject({
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
    });
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectId, 'agent-a'),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .all()
    ).toHaveLength(2);
  });

  it('marks an old revision unsupported only after complete exact-version discovery proves it', async () => {
    const original = provider.listOperationSchemas.bind(provider);
    vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) =>
      request.toolkitVersion === 'old-v1'
        ? { status: 'ok', page: { operations: [], truncated: false } }
        : original(request)
    );

    const preview = await service.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    expect(
      preview.candidates.find((candidate) => candidate.operationRevisionId === 'old-read-v1')
    ).toMatchObject({ toolkitVersion: 'old-v1', supported: false });
    await expect(
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: ['old-read-v1'] }],
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(isNull(connectionOperationGrants.revokedAt))
        .all()
    ).toHaveLength(2);
  });

  it('refuses the whole preview when an old pinned version cannot be verified', async () => {
    const original = provider.listOperationSchemas.bind(provider);
    vi.spyOn(provider as ConnectorProvider, 'listOperationSchemas').mockImplementation(
      async (request) =>
        request.toolkitVersion === 'old-v1'
          ? { status: 'unsupported', reason: 'Exact old version is unavailable.' }
          : original(request)
    );

    await expect(
      service.preview(OWNER, { connectionId: CONNECTION_ID }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'operations_unsupported' });
    expect(db.select().from(connectorReconciliationPreviews).all()).toEqual([]);
  });

  it('treats an explicit empty named-agent set as revocation and leaves omitted agents intact', async () => {
    const preview = await service.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    await service.apply(OWNER, {
      previewId: preview.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
    });

    const rows = db.select().from(connectionOperationGrants).all();
    expect(rows.find((row) => row.subjectId === 'agent-a')?.revokedAt).toBe(NOW.toISOString());
    expect(rows.find((row) => row.subjectId === 'agent-b')?.revokedAt).toBeNull();
  });

  it('rejects a changed material generation and does not consume or mutate the preview', async () => {
    const preview = await service.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    db.update(connectorProviderInstances)
      .set({ executionConfigGeneration: 2 })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();

    await expect(
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
      })
    ).rejects.toBeInstanceOf(ConnectorReconciliationError);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(isNull(connectionOperationGrants.revokedAt))
        .all()
    ).toHaveLength(2);
  });

  it('rechecks current agent ownership before replacing grants or consuming the preview', async () => {
    const preview = await service.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    agents = [{ agentId: 'agent-b', displayName: 'Beta' }];

    await expect(
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
      })
    ).rejects.toBeInstanceOf(ConnectorReconciliationError);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(isNull(connectionOperationGrants.revokedAt))
        .all()
    ).toHaveLength(2);

    agents = [
      { agentId: 'agent-a', displayName: 'Alpha' },
      { agentId: 'agent-b', displayName: 'Beta' },
    ];
    await expect(
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
      })
    ).resolves.toMatchObject({ authoritySync: { status: 'ready' } });
  });

  it('rejects foreign owners without revealing whether the connection exists', async () => {
    await expect(
      service.preview(
        { kind: 'local_install', installationId: 'install-b' },
        { connectionId: CONNECTION_ID },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'connection_not_found' });
  });
});
