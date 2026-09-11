import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentConnectionAttachments,
  connectionOperationGrants,
  connections,
  connectorEventSubscriptions,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectedAccount } from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../registry.js';

const NOW = '2026-09-05T12:00:00.000Z';

describe('ConnectionStore lifecycle and cleanup', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let connection: ConnectedAccount;

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider();
    registry.register(provider);
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });
    connection = registry.recordConnect(provider, (await provider.pollConnect(flowId)).account!);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-1',
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: '2026-09-01',
        schemaHash: 'sha256:read-1',
        capabilityClassification: 'read',
        inputSchemaJson: '{}',
        discoveredAt: NOW,
      })
      .run();
  });

  it('keeps removed accounts hidden on passive refresh and gives an approved replacement a fresh id', async () => {
    const account = (await provider.listAccounts())[0]!;
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-1',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: connection.id,
        operationRevisionId: 'revision-1',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    db.insert(connectorUsageAttempts)
      .values({
        attemptId: 'attempt-1',
        logicalOperationId: 'logical-1',
        attemptIndex: 1,
        surface: 'mcp',
        actorKind: 'agent',
        actorId: 'agent-a',
        ownerKind: 'local_install',
        ownerId: 'installation-a',
        agentId: 'agent-a',
        connectionId: connection.id,
        providerInstanceId: provider.instanceId,
        providerType: provider.type,
        payer: 'operator_byo',
        operationRevisionId: 'revision-1',
        startedAt: NOW,
      })
      .run();
    registry.recordDisconnect(connection.id);
    db.update(connections)
      .set({ removedAt: NOW, externalCleanupState: 'complete' })
      .where(eq(connections.id, connection.id))
      .run();
    expect((await registry.listAccounts()).accounts).toEqual([]);
    expect(registry.recordConnect(provider, account).id).toBe(connection.id);
    expect(db.select().from(connections).all()).toHaveLength(1);
    const replacement = registry.recordConnect(provider, account, {
      allowRemovedReplacement: true,
    });
    expect(replacement.id).not.toBe(connection.id);
    expect(db.select().from(connections).all()).toHaveLength(2);
    expect(db.select().from(connectionOperationGrants).all()).toMatchObject([
      { connectionId: connection.id, revokedAt: expect.any(String) },
    ]);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.connectionId, replacement.id))
        .all()
    ).toEqual([]);
    expect(db.select().from(connectorUsageAttempts).get()?.connectionId).toBe(connection.id);
    expect((await registry.listAccounts()).accounts.map((row) => row.id)).toEqual([replacement.id]);
    expect(
      db.select().from(connections).where(eq(connections.id, connection.id)).get()?.removedAt
    ).toBe(NOW);
  });

  it('refuses same-reference replacement before cleanup acknowledgement', async () => {
    const account = (await provider.listAccounts())[0]!;
    registry.recordDisconnect(connection.id);
    db.update(connections)
      .set({ removedAt: NOW, externalCleanupState: 'pending' })
      .where(eq(connections.id, connection.id))
      .run();
    expect(() =>
      registry.recordConnect(provider, account, { allowRemovedReplacement: true })
    ).toThrow('cleanup is not confirmed');
    expect(db.select().from(connections).all()).toHaveLength(1);
  });

  it('keeps operator pause separate from provider authentication state', async () => {
    registry.setPaused(connection.id, true);
    expect(registry.accountBinding(connection.id)?.status).toBe('paused');
    expect(db.select({ status: connections.status }).from(connections).get()).toEqual({
      status: 'active',
    });

    const externalAccountRef = registry.accountBinding(connection.id)!.externalAccountRef;
    provider.setStatus(externalAccountRef, 'expired');
    registry.recordConnect(provider, (await provider.listAccounts())[0]!);
    expect(registry.accountBinding(connection.id)?.status).toBe('paused');

    registry.setPaused(connection.id, false);
    expect(registry.accountBinding(connection.id)?.status).toBe('expired');
  });

  it('advances material config generation only when the execution digest changes', () => {
    registry.register(provider, 'digest-a');
    const first = db
      .select()
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .get()!;

    registry.register(provider, 'digest-a');
    const unchanged = db
      .select()
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .get()!;
    expect(unchanged.executionConfigGeneration).toBe(first.executionConfigGeneration);

    db.update(connections)
      .set({ grantReconciliationStatus: 'ready' })
      .where(eq(connections.id, connection.id))
      .run();
    registry.register(provider, 'digest-b');
    const changed = db
      .select()
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .get()!;
    expect(changed.executionConfigGeneration).toBe(first.executionConfigGeneration + 1);
    expect(changed.executionConfigDigest).toBe('digest-b');
    expect(db.select().from(connections).get()?.grantReconciliationStatus).toBe(
      'migration_needs_reconcile'
    );
  });

  it('fences existing authority when the explicit provider deployment mode changes', () => {
    db.update(connections)
      .set({ grantReconciliationStatus: 'ready' })
      .where(eq(connections.id, connection.id))
      .run();
    const before = db
      .select({ generation: connectorProviderInstances.executionConfigGeneration })
      .from(connectorProviderInstances)
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .get()!;

    registry.register(provider, undefined, 'managed');

    expect(
      db
        .select({
          generation: connectorProviderInstances.executionConfigGeneration,
          mode: connectorProviderInstances.mode,
        })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, provider.instanceId))
        .get()
    ).toEqual({ generation: before.generation + 1, mode: 'managed' });
    expect(db.select().from(connections).get()?.grantReconciliationStatus).toBe(
      'migration_needs_reconcile'
    );
  });

  it('binds configured providers to one verified owner without reassignment', () => {
    const owned = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: 'install-a' },
    });
    owned.register(provider, 'digest-a');
    expect(
      db
        .select()
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, provider.instanceId))
        .get()
    ).toMatchObject({ ownerKind: 'local_install', ownerId: 'install-a' });

    const foreign = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: 'install-b' },
    });
    expect(() => foreign.register(provider, 'digest-a')).toThrow(
      'Configured connector provider belongs to a different owner.'
    );
  });

  it('tombstones disconnect while retaining immutable revisions and historical usage', () => {
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-1',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: connection.id,
        operationRevisionId: 'revision-1',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    db.insert(connectorUsageAttempts)
      .values({
        attemptId: 'attempt-1',
        logicalOperationId: 'logical-1',
        attemptIndex: 1,
        surface: 'mcp',
        actorKind: 'agent',
        actorId: 'agent-a',
        ownerKind: 'local_install',
        ownerId: 'installation-a',
        agentId: 'agent-a',
        connectionId: connection.id,
        providerInstanceId: provider.instanceId,
        providerType: provider.type,
        payer: 'operator_byo',
        operationRevisionId: 'revision-1',
        startedAt: NOW,
      })
      .run();

    registry.recordDisconnect(connection.id);

    expect(db.select().from(connections).get()).toMatchObject({
      status: 'active',
      lifecycleState: 'disconnected',
    });
    expect(registry.accountBinding(connection.id)?.status).toBe('revoked');
    expect(db.select().from(connectorOperationRevisions).all()).toHaveLength(1);
    expect(db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(db.select().from(connectionOperationGrants).get()?.revokedAt).not.toBeNull();
  });

  it('does not let a deferred provider inventory restore a disconnected connection', async () => {
    const privateAccount = (await provider.listAccounts())[0]!;
    let releaseInventory!: () => void;
    const inventoryBlocked = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    provider.listAccounts = async () => {
      await inventoryBlocked;
      return [{ ...privateAccount, status: 'active' }];
    };

    const staleInventory = registry.listAccounts();
    registry.recordDisconnect(connection.id);
    releaseInventory();

    expect((await staleInventory).accounts).toMatchObject([
      { id: connection.id, status: 'revoked' },
    ]);
    expect(registry.accountBinding(connection.id)?.status).toBe('revoked');
    expect(db.select().from(connections).get()).toMatchObject({
      status: 'active',
      lifecycleState: 'disconnected',
    });

    const explicitlyReconnected = registry.recordConnect(provider, privateAccount);
    expect(explicitlyReconnected).toMatchObject({ id: connection.id, status: 'active' });
    expect(db.select().from(connections).get()?.lifecycleState).toBe('connected');
  });

  it('restores a disconnected stable id only when the connect target is unambiguous', async () => {
    registry.recordDisconnect(connection.id);
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const personal = registry.recordConnect(
      provider,
      (await provider.pollConnect(flowId)).account!
    );
    registry.recordDisconnect(personal.id);

    expect(registry.disconnectedConnectionFor(provider, 'gmail')).toBeUndefined();
    expect(registry.disconnectedConnectionFor(provider, 'gmail', 'work')).toBe(connection.id);
    expect(registry.disconnectedConnectionFor(provider, 'gmail', 'personal')).toBe(personal.id);
  });

  it('removes all owned authority for one agent without touching another agent', () => {
    for (const agentId of ['agent-a', 'agent-b']) {
      db.insert(agentConnectionAttachments)
        .values({ agentId, connectionId: connection.id, attachedAt: NOW })
        .run();
      db.insert(sessionConnectionOverrides)
        .values({
          sessionId: `session-${agentId}`,
          agentId,
          connectionId: connection.id,
          state: 'attached',
          needsReconciliation: false,
          updatedAt: NOW,
        })
        .run();
      db.insert(connectionOperationGrants)
        .values({
          id: `grant-${agentId}`,
          subjectType: 'agent',
          subjectId: agentId,
          agentId,
          connectionId: connection.id,
          operationRevisionId: 'revision-1',
          createdBy: 'operator',
          createdAt: NOW,
        })
        .run();
      db.insert(connectorEventSubscriptions)
        .values({
          id: `subscription-${agentId}`,
          connectionId: connection.id,
          agentId,
          destinationKind: 'agent',
          destinationId: agentId,
          eventType: 'message.received',
          filterJson: '{}',
          filterHash: 'none',
          deliveryMode: 'direct',
          createdBy: 'operator',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }

    expect(registry.removeAgentAccess('agent-a')).toEqual(['session-agent-a']);

    expect(db.select().from(agentConnectionAttachments).all()).toMatchObject([
      { agentId: 'agent-b' },
    ]);
    expect(db.select().from(sessionConnectionOverrides).all()).toMatchObject([
      { agentId: 'agent-b' },
    ]);
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.agentId, 'agent-a'))
        .get()?.revokedAt
    ).not.toBeNull();
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.agentId, 'agent-b'))
        .get()?.revokedAt
    ).toBeNull();
    expect(
      db
        .select()
        .from(connectorEventSubscriptions)
        .where(eq(connectorEventSubscriptions.agentId, 'agent-a'))
        .get()?.enabled
    ).toBe(false);
    expect(
      db
        .select()
        .from(connectorEventSubscriptions)
        .where(eq(connectorEventSubscriptions.agentId, 'agent-b'))
        .get()?.enabled
    ).toBe(true);
  });
});
