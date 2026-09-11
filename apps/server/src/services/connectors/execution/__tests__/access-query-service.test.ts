/** Owner and agent scoping for public connector access and usage reads. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorAccessQueryError, ConnectorAccessQueryService } from '../access-query-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const OTHER_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const STARTED_AT = '2026-09-06T12:00:00.000Z';
const RUNTIME_PRINCIPAL = createServerPrincipal({
  kind: 'runtime',
  owner: OWNER,
  bindingId: 'binding-a',
  runtime: 'codex',
  canonicalSessionId: 'session-a',
  agentId: 'agent-a',
  agentPath: '/agents/agent-a',
  canonicalCwd: '/repo-a',
});

describe('ConnectorAccessQueryService', () => {
  let db: Db;
  let service: ConnectorAccessQueryService;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(
      new FakeConnectorProvider({
        type: 'fake',
        instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
        custody: 'self-host',
      }),
      'material-a'
    );
    db.insert(connections)
      .values({
        id: 'connection-a',
        providerInstanceId: 'provider-a',
        externalAccountRef: 'private-account-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: false,
        grantReconciliationStatus: 'ready',
        createdAt: STARTED_AT,
        updatedAt: STARTED_AT,
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: 'provider-a',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: STARTED_AT,
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: STARTED_AT,
      })
      .run();
    service = new ConnectorAccessQueryService(
      db,
      {
        ownsAgent: (_owner, agentId) => agentId === 'agent-a',
      },
      registry,
      { revalidatePrincipal: async () => true }
    );
  });

  it('snapshots scoped access changes even when the number of accounts stays the same', async () => {
    db.update(connections).set({ enabled: true }).run();
    const initial = await service.accessSnapshot(OWNER, 'agent-a', 'session-a');
    expect(initial.accountCount).toBe(1);
    expect(JSON.stringify(initial)).not.toMatch(/Work Gmail|private-account|connection-a/);
    db.update(connectionOperationGrants).set({ revokedAt: STARTED_AT }).run();
    const revoked = await service.accessSnapshot(OWNER, 'agent-a', 'session-a');
    expect(revoked.accountCount).toBe(0);
    db.update(connectionOperationGrants)
      .set({ revokedAt: null, createdAt: '2026-09-11T00:00:00Z' })
      .run();
    const readded = await service.accessSnapshot(OWNER, 'agent-a', 'session-a');
    expect(readded.accountCount).toBe(1);
    expect(readded.revision).not.toBe(initial.revision);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-b',
        providerInstanceId: 'provider-a',
        toolkit: 'gmail',
        operationSlug: 'gmail.profile.get',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:b',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{}',
        discoveredAt: STARTED_AT,
      })
      .run();
    db.update(connectionOperationGrants).set({ operationRevisionId: 'revision-b' }).run();
    const changedOperation = await service.accessSnapshot(OWNER, 'agent-a', 'session-a');
    expect(changedOperation.accountCount).toBe(1);
    expect(changedOperation.revision).not.toBe(readded.revision);
  });

  it('reads pause, reconciliation, and session overrides afresh without leaking foreign inventory', async () => {
    const paused = await service.accessSnapshot(OWNER, 'agent-a', 'session-a');
    expect(paused.accountCount).toBe(0);
    db.update(connections).set({ enabled: true }).run();
    const enabled = await service.accessSnapshot(OWNER, 'agent-a', 'session-a');
    expect(enabled.accountCount).toBe(1);
    db.update(connections).set({ grantReconciliationStatus: 'migration_needs_reconcile' }).run();
    expect((await service.accessSnapshot(OWNER, 'agent-a', 'session-a')).accountCount).toBe(0);
    expect((await service.accessSnapshot(OTHER_OWNER, 'agent-a', 'session-a')).accountCount).toBe(
      0
    );
    await expect(service.accessSnapshot(OWNER, 'foreign-agent', 'session-a')).rejects.toMatchObject(
      { code: 'agent_not_owned' }
    );
  });

  it('returns paused granted connections and exact immutable operation schemas only to the owner', async () => {
    await expect(service.listConnections(OWNER, 'agent-a')).resolves.toEqual({
      connections: [
        {
          connectionId: 'connection-a',
          toolkit: 'gmail',
          label: 'Work Gmail',
          status: 'paused',
          custody: 'self-host',
          reconciliationStatus: 'ready',
        },
      ],
    });
    await expect(service.listOperations(OWNER, 'agent-a', 'connection-a')).resolves.toEqual({
      connectionId: 'connection-a',
      operations: [
        {
          operationRevisionId: 'revision-a',
          toolkit: 'gmail',
          operationSlug: 'gmail.messages.list',
          toolkitVersion: '20260901',
          capabilityClassification: 'read',
          retryPolicy: 'never',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    await expect(service.listConnections(OTHER_OWNER, 'agent-a')).resolves.toEqual({
      connections: [],
    });
    await expect(service.listConnections(OWNER, 'foreign-agent')).rejects.toMatchObject({
      code: 'agent_not_owned',
    } satisfies Partial<ConnectorAccessQueryError>);
  });

  it('returns executable runtime targets and exact schemas without enumerating another agent grant', async () => {
    db.update(connections).set({ enabled: true }).where(eq(connections.id, 'connection-a')).run();

    await expect(service.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toMatchObject({
      connections: [{ connectionId: 'connection-a', status: 'active' }],
    });
    await expect(service.listRuntimeOperations(RUNTIME_PRINCIPAL, 'connection-a')).resolves.toEqual(
      {
        connectionId: 'connection-a',
        operations: [
          {
            operationRevisionId: 'revision-a',
            toolkit: 'gmail',
            operationSlug: 'gmail.messages.list',
            toolkitVersion: '20260901',
            capabilityClassification: 'read',
            retryPolicy: 'never',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }
    );

    db.update(connectionOperationGrants)
      .set({ revokedAt: STARTED_AT })
      .where(eq(connectionOperationGrants.id, 'grant-a'))
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-foreign',
        subjectType: 'agent',
        subjectId: 'agent-b',
        agentId: 'agent-b',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: STARTED_AT,
      })
      .run();
    await expect(service.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
    });
  });

  it('applies detached and attached session precedence to runtime discovery', async () => {
    db.update(connections).set({ enabled: true }).where(eq(connections.id, 'connection-a')).run();
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'detached',
        updatedAt: STARTED_AT,
      })
      .run();
    await expect(service.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
    });

    db.update(sessionConnectionOverrides)
      .set({ state: 'attached' })
      .where(eq(sessionConnectionOverrides.sessionId, 'session-a'))
      .run();
    await expect(service.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
    });

    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-session-a',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: STARTED_AT,
      })
      .run();
    await expect(service.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toMatchObject({
      connections: [{ connectionId: 'connection-a' }],
    });
  });

  it('pages immutable usage without exposing actor ids, provider logs, arguments, or results', async () => {
    for (const [index, attemptId] of ['attempt-c', 'attempt-b', 'attempt-a'].entries()) {
      db.insert(connectorUsageAttempts)
        .values({
          attemptId,
          logicalOperationId: `logical-${attemptId}`,
          attemptIndex: index + 1,
          surface: index === 0 ? 'cli' : 'rest',
          actorKind: 'program',
          actorId: 'credential-private',
          ownerKind: 'local_install',
          ownerId: OWNER.installationId,
          agentId: 'agent-a',
          connectionId: 'connection-a',
          providerInstanceId: 'provider-a',
          providerType: 'fake',
          payer: 'operator_byo',
          operationRevisionId: 'revision-a',
          startedAt: STARTED_AT,
        })
        .run();
      db.insert(connectorUsageTerminalReceipts)
        .values({
          receiptId: `receipt-${attemptId}`,
          attemptId,
          outcome: 'success',
          providerLogId: `private-log-${attemptId}`,
          completedAt: STARTED_AT,
          recordedAt: STARTED_AT,
          provenance: 'broker',
        })
        .run();
    }

    const first = await service.listAgentUsage(OWNER, 'agent-a', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect(JSON.stringify(first)).not.toContain('credential-private');
    expect(JSON.stringify(first)).not.toContain('private-log');
    expect(JSON.stringify(first)).not.toContain('arguments');
    expect(JSON.stringify(first)).not.toContain('result');

    const second = await service.listAgentUsage(OWNER, 'agent-a', {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      service.listAgentUsage(OWNER, 'agent-a', { cursor: 'not-a-real-cursor' })
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    expect(service.listOperatorUsage(OTHER_OWNER, {})).toEqual({ items: [] });
  });
});
