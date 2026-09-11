/** Approved management effects stay exact, owner-bound, and idempotent. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectorAuthorityCleanupPort } from '../authority-cleanup-port.js';
import {
  ConnectorManagementActionError,
  ConnectorManagementActionService,
} from '../management-action-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const NOW = new Date('2026-09-06T12:00:00.000Z');

describe('ConnectorManagementActionService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let cleanup: ConnectorAuthorityCleanupPort;
  let service: ConnectorManagementActionService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider({ instanceId: PROVIDER_ID });
    registry.register(provider, 'material-a');
    db.update(connectorProviderInstances)
      .set({ ownerKind: OWNER.kind, ownerId: OWNER.installationId })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: PROVIDER_ID,
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
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail_list_messages',
        toolkitVersion: 'v1',
        schemaHash: 'schema-a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
    cleanup = {
      revokeAgent: vi.fn(),
      revokeAgentConnection: vi.fn(),
      revokeConnection: vi.fn(),
    };
    service = new ConnectorManagementActionService({
      db,
      registry,
      authorityCleanup: cleanup,
      now: () => NOW,
      createId: () => 'grant-a',
    });
  });

  it('closes authority before a synchronous provider disconnect failure', async () => {
    vi.spyOn(provider, 'disconnect').mockImplementation(() => {
      expect(db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        externalCleanupState: 'unknown',
        cleanupGeneration: 1,
      });
      expect(cleanup.revokeConnection).toHaveBeenCalledWith({
        connectionId: CONNECTION_ID,
        reason: 'connection_removed',
      });
      throw new Error('synthetic immediate failure');
    });
    await expect(
      service.apply(OWNER, { version: 1, kind: 'disconnect', connectionId: CONNECTION_ID })
    ).rejects.toThrow('synthetic immediate failure');
    expect(registry.accountBinding(CONNECTION_ID)?.status).toBe('revoked');
  });

  it('updates only the exact owner connection lifecycle and label', async () => {
    await service.apply(OWNER, {
      version: 1,
      kind: 'edit',
      connectionId: CONNECTION_ID,
      label: 'Home',
    });
    await service.apply(OWNER, { version: 1, kind: 'pause', connectionId: CONNECTION_ID });
    expect(
      db.select().from(connections).where(eq(connections.id, CONNECTION_ID)).get()
    ).toMatchObject({
      label: 'Home',
      enabled: false,
    });

    await service.apply(OWNER, { version: 1, kind: 'resume', connectionId: CONNECTION_ID });
    expect(
      db.select().from(connections).where(eq(connections.id, CONNECTION_ID)).get()?.enabled
    ).toBe(true);
    await expect(
      service.apply(FOREIGN_OWNER, { version: 1, kind: 'pause', connectionId: CONNECTION_ID })
    ).rejects.toMatchObject({ code: 'target_not_found' });
  });

  it('replaces exact agent grants idempotently and rejects foreign revisions', async () => {
    const action = {
      version: 1,
      kind: 'set_agent_access',
      connectionId: CONNECTION_ID,
      agentId: 'agent-a',
      operationRevisionIds: ['revision-a'] as string[],
    } as const;
    await service.apply(OWNER, action);
    await service.apply(OWNER, action);
    expect(db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(db.select().from(connectionOperationGrants).get()).toMatchObject({
      subjectId: 'agent-a',
      connectionId: CONNECTION_ID,
      operationRevisionId: 'revision-a',
      revokedAt: null,
    });

    await expect(
      service.apply(OWNER, { ...action, operationRevisionIds: ['revision-missing'] })
    ).rejects.toBeInstanceOf(ConnectorManagementActionError);
  });

  it('revokes exact agent access without invalidating unrelated runtime authority', async () => {
    await service.apply(OWNER, {
      version: 1,
      kind: 'remove_agent_access',
      connectionId: CONNECTION_ID,
      agentId: 'agent-a',
    });
    expect(cleanup.revokeAgentConnection).toHaveBeenCalledWith({
      agentId: 'agent-a',
      connectionId: CONNECTION_ID,
      reason: 'agent_connection_removed',
    });
  });

  it('tombstones locally and cleans pending authority before provider disconnect completes', async () => {
    const disconnect = vi.spyOn(provider, 'disconnect').mockResolvedValue(undefined);
    await service.apply(OWNER, {
      version: 1,
      kind: 'disconnect',
      connectionId: CONNECTION_ID,
    });
    expect(disconnect).toHaveBeenCalledWith('external-a');
    expect(registry.accountBinding(CONNECTION_ID)?.status).toBe('revoked');
    expect(cleanup.revokeConnection).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      reason: 'connection_removed',
    });
  });
});
