/** Complete snapshots, named-agent replacement, and stale-preview refusal. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
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
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../registry.js';
import {
  ConnectorReconciliationError,
  ConnectorReconciliationService,
} from '../reconciliation-service.js';

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
      pageSize: 1,
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
    const applied = service.apply(OWNER, {
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
    expect(() =>
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: ['old-read-v1'] }],
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_selection' }));
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
    service.apply(OWNER, {
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

    expect(() =>
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
      })
    ).toThrowError(ConnectorReconciliationError);
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

    expect(() =>
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
      })
    ).toThrowError(ConnectorReconciliationError);
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
    expect(() =>
      service.apply(OWNER, {
        previewId: preview.previewId,
        grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
      })
    ).not.toThrow();
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
