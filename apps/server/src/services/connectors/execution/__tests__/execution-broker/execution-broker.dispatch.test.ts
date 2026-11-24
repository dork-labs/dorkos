import { describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connectionAccessLevels,
  connections,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  eq,
} from '@dorkos/db';
import { ConnectionStore } from '../../../connection-store.js';
import { ConnectorRegistry } from '../../../registry.js';
import { createServerPrincipal } from '../../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../../authorization-service.js';
import { ConnectorExecutionBroker } from '../../execution-broker.js';
import {
  ManagedConnectorExecutionContextStore,
  type ManagedConnectorExecutionContext,
} from '../../managed-execution-context.js';
import { ConnectorUsageStore } from '../../usage-store.js';
import {
  OWNER,
  CONNECTION_ID,
  REVISION_ID,
  EXTERNAL_REF,
  PROVIDER_SHAPED_INPUT_SCHEMA,
  useExecutionBrokerHarness,
  openRuntimeTurn,
} from './execution-broker.fixtures.js';

/** What the broker refuses before dispatch, and what it records around a managed attempt. */
describe('ConnectorExecutionBroker', () => {
  const h = useExecutionBrokerHarness();

  it('fails closed on an unknown action even with a Read and write grant', async () => {
    h.db
      .insert(connectionAccessLevels)
      .values({
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        level: 'read-write',
        createdBy: 'operator',
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    await expect(h.execute()).resolves.toMatchObject({ result: { status: 'success' } });
    expect(h.provider.dispatchedCommands).toHaveLength(1);
    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, {
        ...h.target,
        operationRevisionId: 'revision-never-discovered',
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_TARGET_NOT_FOUND' } });
    expect(h.provider.commands).toHaveLength(1);
    expect(h.provider.dispatchedCommands).toHaveLength(1);
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
  });

  it('refuses a paid write at execution under a stored Read and write grant', async () => {
    // Model a level row saved before paid-operation filtering existed.
    h.db
      .update(connections)
      .set({ toolkit: 'apify' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    const paidTarget = { ...h.target, operationRevisionId: 'revision-paid' };
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: paidTarget.operationRevisionId,
        providerInstanceId: h.provider.instanceId,
        toolkit: 'apify',
        operationSlug: 'apify.run',
        toolkitVersion: '2026-09-01',
        capabilityClassification: 'write',
        retryPolicy: 'never',
        schemaHash: 'sha256:paid',
        providerRevisionRef: '10000000-0000-4000-8000-000000000004',
        inputSchemaJson: JSON.stringify(PROVIDER_SHAPED_INPUT_SCHEMA),
        discoveredAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'grant-paid',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: paidTarget.operationRevisionId,
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    h.db
      .insert(connectionAccessLevels)
      .values({
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        level: 'read-write',
        createdBy: 'operator',
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, paidTarget)
    ).rejects.toMatchObject({
      payload: {
        code: 'CONNECTOR_GRANT_REQUIRED',
        error: expect.stringContaining('spends money'),
      },
    });
    expect(h.provider.commands).toEqual([]);
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
    // The same exact action runs once the grant is hand-picked rather than a level.
    h.db.delete(connectionAccessLevels).run();
    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, paidTarget)
    ).resolves.toMatchObject({ result: { status: 'success' } });
    expect(h.provider.dispatchedCommands).toHaveLength(1);
  });

  it('persists intent before dispatch and a separate terminal receipt without provider-private ids', async () => {
    h.provider.results.push({
      status: 'success',
      data: { delivered: true, url: 'https://mail.example/message/1' },
      providerLogId: 'private-log-a',
    });

    await expect(h.execute()).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'success', data: { delivered: true } },
    });
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(h.db.select().from(connectorUsageTerminalReceipts).get()).toMatchObject({
      outcome: 'success',
      providerLogId: 'private-log-a',
    });
    expect(h.provider.commands).toHaveLength(1);
    expect(h.provider.dispatchedCommands).toHaveLength(1);
  });

  it('binds a managed attempt to the latest applied hosted scope without blocking old grants on a pending edit', async () => {
    h.db
      .update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();
    const baseOutbox = {
      connectionId: CONNECTION_ID,
      providerInstanceId: h.provider.instanceId,
      executionConfigGeneration: 1,
      ownerKind: OWNER.kind,
      ownerId: OWNER.installationId,
      managedConnectionId: EXTERNAL_REF,
      scopeKind: 'agent_grants' as const,
      subjectId: 'agent-a',
      requestHash: 'request-a',
      requestJson: '{}',
      safeReason: null,
      attemptCount: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leasedUntil: null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
      resolvedAt: null,
      compactedAt: null,
    };
    h.db
      .insert(connectorManagedAuthorityOutbox)
      .values([
        {
          ...baseOutbox,
          commandId: 'scope-applied',
          scopeVersion: 4,
          state: 'applied',
          resolvedAt: '2026-09-06T12:00:00.000Z',
        },
        {
          ...baseOutbox,
          commandId: 'scope-pending',
          scopeVersion: 5,
          state: 'pending',
        },
      ])
      .run();
    const contexts = new ManagedConnectorExecutionContextStore();
    let captured: ManagedConnectorExecutionContext | undefined;
    h.provider.onCommand = (command) => {
      captured = contexts.resolve(command);
    };
    h.broker = new ConnectorExecutionBroker(
      h.authorization,
      new ConnectorUsageStore(h.db),
      { revalidate: () => true },
      () => new Date('2026-09-06T12:00:01.000Z'),
      contexts
    );

    await expect(h.execute()).resolves.toMatchObject({ result: { status: 'success' } });
    expect(captured).toEqual({
      agentId: 'agent-a',
      attemptIndex: 1,
      grantScopeVersion: 4,
      grantSubject: 'agent',
      hostedRevisionId: '10000000-0000-4000-8000-000000000001',
      attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-a' },
    });
  });

  // #3196 review, S2: the owner's approval card can say the turn read outside words.
  it('carries the calling turn’s marks, derived by the broker, to the managed attempt', async () => {
    h.db
      .update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();
    const baseOutbox = {
      connectionId: CONNECTION_ID,
      providerInstanceId: h.provider.instanceId,
      executionConfigGeneration: 1,
      ownerKind: OWNER.kind,
      ownerId: OWNER.installationId,
      managedConnectionId: EXTERNAL_REF,
      scopeKind: 'agent_grants' as const,
      subjectId: 'agent-a',
      requestHash: 'request-a',
      requestJson: '{}',
      safeReason: null,
      attemptCount: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leasedUntil: null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
      resolvedAt: null,
      compactedAt: null,
    };
    h.db
      .insert(connectorManagedAuthorityOutbox)
      .values([
        {
          ...baseOutbox,
          commandId: 'scope-applied',
          scopeVersion: 4,
          state: 'applied',
          resolvedAt: '2026-09-06T12:00:00.000Z',
        },
        {
          ...baseOutbox,
          commandId: 'scope-pending',
          scopeVersion: 5,
          state: 'pending',
        },
      ])
      .run();
    const contexts = new ManagedConnectorExecutionContextStore();
    let captured: ManagedConnectorExecutionContext | undefined;
    h.provider.onCommand = (command) => {
      captured = contexts.resolve(command);
    };
    h.broker = new ConnectorExecutionBroker(
      h.authorization,
      new ConnectorUsageStore(h.db),
      { revalidate: () => true },
      () => new Date('2026-09-06T12:00:01.000Z'),
      contexts,
      undefined,
      () => ['outsider']
    );

    await expect(h.execute()).resolves.toMatchObject({ result: { status: 'success' } });
    expect(captured).toEqual({
      agentId: 'agent-a',
      attemptIndex: 1,
      grantScopeVersion: 4,
      grantSubject: 'agent',
      hostedRevisionId: '10000000-0000-4000-8000-000000000001',
      attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-a', marks: ['outsider'] },
    });
  });

  it('refuses an unbound legacy managed revision before intent instead of guessing by slug', async () => {
    h.db
      .update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();
    const original = h.db
      .select()
      .from(connectorOperationRevisions)
      .where(eq(connectorOperationRevisions.id, REVISION_ID))
      .get()!;
    h.db
      .insert(connectorOperationRevisions)
      .values({ ...original, id: 'legacy-unbound', providerRevisionRef: '' })
      .run();
    h.db
      .update(connectionOperationGrants)
      .set({ operationRevisionId: 'legacy-unbound' })
      .where(eq(connectionOperationGrants.operationRevisionId, REVISION_ID))
      .run();
    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, {
        ...h.target,
        operationRevisionId: 'legacy-unbound',
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_MANAGED_REVISION_REQUIRED' } });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
    expect(h.provider.commands).toEqual([]);
  });

  it('refuses managed execution before intent when no hosted grant scope has applied', async () => {
    h.db
      .update(connectorProviderInstances)
      .set({ mode: 'managed' })
      .where(eq(connectorProviderInstances.id, h.provider.instanceId))
      .run();

    await expect(h.execute()).rejects.toMatchObject({
      payload: { code: 'CONNECTOR_MANAGED_AUTHORITY_PENDING' },
    });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
    expect(h.provider.commands).toEqual([]);
  });

  it('refuses a durable runtime principal before dispatch when connector migration failed', async () => {
    const { runtimePrincipals, resolved } = await openRuntimeTurn(h.db, {
      makeBootEpoch: () => 'boot-migration-failure',
      makeBearer: () => 'bearer-migration-failure',
    });

    const unavailableRegistry = new ConnectorRegistry({
      db: h.db,
      connectionStore: new ConnectionStore({
        db: h.db,
        runMigration: () => ({
          status: 'migration_failed',
          error: 'Connector data is temporarily unavailable.',
        }),
      }),
    });
    unavailableRegistry.register(h.provider);
    h.authorization = new ConnectorExecutionAuthorizationService(h.db, unavailableRegistry, {
      ownsAgent: () => true,
    });
    h.broker = new ConnectorExecutionBroker(
      h.authorization,
      new ConnectorUsageStore(h.db),
      { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
      () => new Date('2026-09-06T12:00:01.000Z')
    );

    await expect(h.execute(resolved.principal)).rejects.toMatchObject({ code: 'migration_failed' });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
    expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toEqual([]);
    expect(h.provider.commands).toEqual([]);
  });

  it('refuses owner mismatch before intent or provider dispatch', async () => {
    const other = createServerPrincipal({
      kind: 'agent',
      owner: { kind: 'local_install', installationId: 'install-b' },
      agentId: 'agent-a',
      agentPath: '/agents/agent-a',
    });

    await expect(
      h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: other,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
    expect(h.provider.commands).toEqual([]);
  });
});
