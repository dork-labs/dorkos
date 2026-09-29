/** Owner and agent scoping for public connector access and usage reads. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  createDb,
  eq,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import type { ConnectionWayHealth } from '../../readiness/connection-readiness.js';
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
      unavailable: [expect.objectContaining({ reason: 'off_for_this_chat' })],
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

  it('says why each account it was given can’t be used, instead of dropping it silently', async () => {
    db.update(connections).set({ enabled: true }).where(eq(connections.id, 'connection-a')).run();
    const withWays = new ConnectorAccessQueryService(
      db,
      { ownsAgent: (_owner, agentId) => agentId === 'agent-a' },
      registry,
      { revalidatePrincipal: async () => true },
      (providerInstanceId): ConnectionWayHealth =>
        registry.resolveProviderInstance(providerInstanceId as never)
          ? { status: 'up', canRunActions: true }
          : { status: 'down', problem: 'dorkos_account_unlinked', anotherWayWorks: false }
    );
    // Working: listed as usable, nothing under unavailable.
    await expect(withWays.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [expect.objectContaining({ connectionId: 'connection-a' })],
    });

    // Paused, signed out, waiting on a review, or held by a sign-in again:
    // named, with what the person does.
    for (const [patch, reason, words] of [
      [{ enabled: false }, 'paused', 'Ask them to resume it'],
      [{ status: 'expired' as const }, 'signed_out', 'sign in again'],
      [
        { grantReconciliationStatus: 'migration_needs_reconcile' as const },
        'needs_review',
        'confirm who can use it',
      ],
      [{ enabled: false, pausedBy: 'sign_in' as const }, 'signing_in', 'finish signing in'],
    ] as const) {
      db.update(connections).set(patch).where(eq(connections.id, 'connection-a')).run();
      const listed = await withWays.listRuntimeConnections(RUNTIME_PRINCIPAL);
      expect(listed.connections).toEqual([]);
      expect(listed.unavailable).toEqual([
        {
          connectionId: 'connection-a',
          toolkit: 'gmail',
          label: 'Work Gmail',
          reason,
          note: expect.stringContaining(words),
        },
      ]);
      db.update(connections)
        .set({
          enabled: true,
          pausedBy: null,
          status: 'active',
          grantReconciliationStatus: 'ready',
        })
        .where(eq(connections.id, 'connection-a'))
        .run();
    }

    // Turned off for this chat: named as such, never as "request it".
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        state: 'detached',
        updatedAt: STARTED_AT,
      })
      .run();
    await expect(withWays.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
      unavailable: [
        expect.objectContaining({
          reason: 'off_for_this_chat',
          note: expect.stringContaining('turned this account off for this chat'),
        }),
      ],
    });
    db.delete(sessionConnectionOverrides).run();

    // The way goes (the DorkOS account was unlinked): not usable, but named with the fix.
    registry.unregisterProviderInstance(ConnectorProviderInstanceIdSchema.parse('provider-a'));
    const listed = await withWays.listRuntimeConnections(RUNTIME_PRINCIPAL);
    expect(listed.connections).toEqual([]);
    expect(listed.unavailable).toEqual([
      {
        connectionId: 'connection-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        reason: 'dorkos_account_unlinked',
        note: expect.stringContaining('isn’t linked anymore'),
      },
    ]);
    await expect(
      withWays.listRuntimeOperations(RUNTIME_PRINCIPAL, 'connection-a')
    ).rejects.toMatchObject({ code: 'connection_not_found' });

    // The same agent and session under a different owner never learns of an
    // account on this owner's instance, even one that cannot be used.
    const foreign = createServerPrincipal({
      kind: 'runtime',
      owner: OTHER_OWNER,
      bindingId: 'binding-foreign',
      runtime: 'codex',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/agents/agent-a',
      canonicalCwd: '/repo-a',
    });
    await expect(withWays.listRuntimeConnections(foreign)).resolves.toEqual({ connections: [] });

    // A disconnected account is no longer the agent's: not named.
    db.update(connections)
      .set({ lifecycleState: 'disconnected' })
      .where(eq(connections.id, 'connection-a'))
      .run();
    await expect(withWays.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
    });

    // Another agent's grant on the account never names it to this one.
    db.update(connections)
      .set({ lifecycleState: 'connected' })
      .where(eq(connections.id, 'connection-a'))
      .run();
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
    await expect(withWays.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
    });
  });

  it('lists a DorkOS-account account as usable only once this agent’s own access has applied', async () => {
    db.update(connections).set({ enabled: true }).where(eq(connections.id, 'connection-a')).run();
    db.update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, 'provider-a'))
      .run();
    const command = (commandId: string, scopeVersion: number, state: string, reason?: string) => {
      db.insert(connectorManagedAuthorityOutbox)
        .values({
          commandId,
          connectionId: 'connection-a',
          providerInstanceId: 'provider-a',
          executionConfigGeneration: 1,
          ownerKind: 'local_install',
          ownerId: OWNER.installationId,
          managedConnectionId: 'private-account-a',
          scopeKind: 'agent_grants',
          subjectId: 'agent-a',
          scopeVersion,
          requestHash: `hash-${commandId}`,
          requestJson: '{}',
          state: state as 'pending',
          ...(reason && { safeReason: reason }),
          createdAt: STARTED_AT,
          updatedAt: STARTED_AT,
        })
        .run();
      db.insert(connectorManagedAuthorityScopes)
        .values({
          managedConnectionId: 'private-account-a',
          scopeKind: 'agent_grants',
          subjectId: 'agent-a',
          scopeVersion,
          lastCommandId: commandId,
          lastCommandHash: `hash-${commandId}`,
          updatedAt: STARTED_AT,
        })
        .onConflictDoUpdate({
          target: [
            connectorManagedAuthorityScopes.managedConnectionId,
            connectorManagedAuthorityScopes.scopeKind,
            connectorManagedAuthorityScopes.subjectId,
          ],
          set: { scopeVersion, lastCommandId: commandId },
        })
        .run();
    };

    // Refused at the hosted side: not usable, and the agent is told so.
    command('command-1', 1, 'rejected', 'This account is no longer linked.');
    let listed = await service.listRuntimeConnections(RUNTIME_PRINCIPAL);
    expect(listed.connections).toEqual([]);
    expect(listed.unavailable).toEqual([
      expect.objectContaining({
        connectionId: 'connection-a',
        reason: 'access_update_failed',
        note: expect.stringContaining('didn’t go through'),
      }),
    ]);
    expect((await service.accessSnapshot(OWNER, 'agent-a', 'session-a')).accountCount).toBe(0);
    // A call is refused with the same reason and words.
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-hosted',
        providerInstanceId: 'provider-a',
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.get',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:b',
        providerRevisionRef: '0b6a3f7e-1d2c-4b5a-9e8f-7a6b5c4d3e2f',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: STARTED_AT,
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-hosted',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-hosted',
        createdBy: 'operator',
        createdAt: STARTED_AT,
      })
      .run();
    const authorization = new ConnectorExecutionAuthorizationService(db, registry, {
      ownsAgent: (_owner, agentId) => agentId === 'agent-a',
    });
    const refused = await authorization
      .prepare({
        capabilityId: 'connectors.execute_read',
        principal: RUNTIME_PRINCIPAL,
        target: ConnectorExecutionTargetSchema.parse({
          connectionId: 'connection-a',
          operationRevisionId: 'revision-hosted',
          arguments: {},
        }),
      })
      .then(
        () => undefined,
        (error: { payload?: Record<string, unknown> }) => error.payload
      );
    expect(refused).toEqual({
      code: 'CONNECTOR_MANAGED_AUTHORITY_PENDING',
      reason: 'access_update_failed',
      error: expect.stringContaining('didn’t go through'),
    });

    // A newer change still applying: still not usable, and it says so.
    command('command-2', 2, 'pending');
    listed = await service.listRuntimeConnections(RUNTIME_PRINCIPAL);
    expect(listed.unavailable).toEqual([expect.objectContaining({ reason: 'access_updating' })]);

    // Applied: usable, and counted.
    db.update(connectorManagedAuthorityOutbox)
      .set({ state: 'applied' })
      .where(eq(connectorManagedAuthorityOutbox.commandId, 'command-2'))
      .run();
    listed = await service.listRuntimeConnections(RUNTIME_PRINCIPAL);
    expect(listed.connections).toEqual([expect.objectContaining({ connectionId: 'connection-a' })]);
    expect(listed.unavailable).toBeUndefined();
    expect((await service.accessSnapshot(OWNER, 'agent-a', 'session-a')).accountCount).toBe(1);

    // A later change refused does not take away the access already applied.
    command('command-3', 3, 'rejected', 'Refused.');
    listed = await service.listRuntimeConnections(RUNTIME_PRINCIPAL);
    expect(listed.connections).toEqual([expect.objectContaining({ connectionId: 'connection-a' })]);
  });

  it('never calls an account off for this chat because of another agent’s override', async () => {
    db.update(connections).set({ enabled: true }).where(eq(connections.id, 'connection-a')).run();
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-b',
        connectionId: 'connection-a',
        state: 'detached',
        updatedAt: STARTED_AT,
      })
      .run();
    // Another agent's override in this session shuts this agent out without
    // being this chat's choice for it, so it is dropped, not named.
    await expect(service.listRuntimeConnections(RUNTIME_PRINCIPAL)).resolves.toEqual({
      connections: [],
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
