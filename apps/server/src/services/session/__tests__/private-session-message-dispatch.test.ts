import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  and,
  connectionOperationGrants,
  connectorAgentRequests,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
  connections,
  eq,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  adoptAcceptedPrivateMessages,
  adoptQueuedMessages,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import {
  PrivateSessionMessageAcceptanceService,
  setPrivateSessionMessageAcceptanceService,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageSourceRef,
} from '../private-messages/acceptance.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';
import { ConnectorAgentRequestSourceAdapter } from '../../connectors/agent-request-service.js';
import type { ConnectorEventGrantPort } from '../../connectors/events/grant-port.js';
import { RuntimeRegistry } from '../../core/runtime-registry.js';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const SESSION_ID = '00000000-0000-4000-8000-000000000740';
type AgentRequestRef = Extract<PrivateSessionMessageSourceRef, { kind: 'connector_agent_request' }>;

function seedRequest(db: Db, suffix: string, originRuntime = 'claude-code'): AgentRequestRef {
  const requestId = `request-${suffix}`;
  db.insert(connectorReviewRequests)
    .values({
      id: `review-${suffix}`,
      actionKind: 'agent_connection_request',
      actionVersion: 1,
      requesterKind: 'agent',
      requesterId: 'agent-1',
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      authorityBindingDigest: 'sha256:authority',
      targetKind: 'service',
      targetId: 'gmail',
      actionPayloadJson: '{}',
      state: 'approved',
      expiresAt: '2026-09-08T00:00:00.000Z',
      idempotencyKey: requestId,
      createdAt: NOW.toISOString(),
    })
    .run();
  db.insert(connectorAgentRequests)
    .values({
      id: requestId,
      reviewRequestId: `review-${suffix}`,
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      serviceSlug: 'gmail',
      requestedOperationsJson: '["gmail.read"]',
      requestedEventsJson: '[]',
      reason: 'Read new mail',
      resumeState: 'ready',
      resumeToken: `token-${suffix}`,
      sourceGeneration: `generation-${suffix}`,
      originRuntime,
      originAgentPath: '/agents/researcher',
      originAuthorityDigest: 'sha256:authority',
      outcome: 'granted',
      resolvedConnectionId: 'connection-1',
      resolvedOperationRevisionIdsJson: '["revision-1"]',
      resolvedEventsJson: '[]',
      resolvedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    })
    .run();
  return {
    kind: 'connector_agent_request',
    requestId,
    sourceGeneration: `generation-${suffix}`,
    resumeToken: `token-${suffix}`,
  };
}

function adapter(
  originRuntime = 'claude-code'
): PrivateSessionMessageSourceAdapter<AgentRequestRef> {
  return {
    kind: 'connector_agent_request',
    consume(tx, ref) {
      const changed = tx
        .update(connectorAgentRequests)
        .set({ resumeState: 'resumed' })
        .where(
          and(
            eq(connectorAgentRequests.id, ref.requestId),
            eq(connectorAgentRequests.resumeState, 'ready'),
            eq(connectorAgentRequests.sourceGeneration, ref.sourceGeneration),
            eq(connectorAgentRequests.resumeToken, ref.resumeToken)
          )
        )
        .run().changes;
      if (changed !== 1) throw new Error('stale source claim');
      return {
        sourceKind: ref.kind,
        sourceId: ref.requestId,
        sourceGeneration: ref.sourceGeneration,
        sessionId: SESSION_ID,
        agentId: 'agent-1',
        originRuntime,
        originAgentPath: '/agents/researcher',
        originAuthorityDigest: 'sha256:authority',
        queuePlaceholder: '[Private connection update]',
      };
    },
    async prepare(receipt) {
      return {
        sourceKind: 'connector_agent_request',
        sourceId: receipt.sourceId,
        sourceGeneration: receipt.sourceGeneration,
        content: 'Access to Gmail is ready.',
      };
    },
    revalidate(tx, receipt) {
      const source = tx
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, receipt.sourceId))
        .get();
      if (!source || source.resumeState !== 'resumed') throw new Error('source changed');
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('private receipt adoption', () => {
  let db: Db;
  let queue: MessageQueueStore;
  let runtime: FakeAgentRuntime;
  let service: PrivateSessionMessageAcceptanceService;

  beforeEach(() => {
    db = createTestDb();
    queue = new MessageQueueStore(db);
    runtime = new FakeAgentRuntime();
    runtime.getInternalSessionId.mockReturnValue(undefined);
    service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [adapter()],
      'boot-a',
      () => NOW
    );
    setMessageQueueStore(queue);
    setPrivateSessionMessageAcceptanceService(service);
  });

  afterEach(async () => {
    await settle();
    resetMessageDispatcher();
    setPrivateSessionMessageAcceptanceService(undefined);
    setMessageQueueStore(undefined);
    disposeProjector(SESSION_ID);
  });

  it('recovers one accepted receipt exactly once through the existing dispatcher', async () => {
    const ref = seedRequest(db, 'once');
    const accepted = service.accept(ref);
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const options = {
      sessionId: SESSION_ID,
      projector: getOrCreateProjector(SESSION_ID),
      runtime,
    };

    expect(adoptQueuedMessages(options)).toBe(0);
    expect(adoptAcceptedPrivateMessages(options)).toBe(1);
    expect(adoptAcceptedPrivateMessages(options)).toBe(0);
    await settle();

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'Access to Gmail is ready.',
      expect.any(Object)
    );
    expect(queue.list(SESSION_ID)).toEqual([]);
    expect(
      db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toMatchObject({ state: 'settled', settleOutcome: 'completed' });
  });

  it.each(['claude-code', 'codex', 'opencode'])(
    'reopens an accepted receipt on a cold %s binding and claims before the first send effect',
    async (runtimeType) => {
      const firstRegistry = new RuntimeRegistry();
      firstRegistry.setDb(db);
      await firstRegistry.persistSessionRuntime(SESSION_ID, runtimeType, '/agents/researcher', {
        interactive: false,
      });
      const ref = seedRequest(db, `cold-${runtimeType}`, runtimeType);
      const firstBoot = new PrivateSessionMessageAcceptanceService(
        db,
        queue,
        [adapter(runtimeType)],
        'boot-a',
        () => NOW
      );
      const accepted = firstBoot.accept(ref);

      const coldRuntime = new FakeAgentRuntime(runtimeType);
      coldRuntime.getInternalSessionId.mockReturnValue(undefined);
      coldRuntime.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          expect(
            db
              .select({ state: sessionMessageAcceptanceReceipts.state })
              .from(sessionMessageAcceptanceReceipts)
              .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
              .get()
          ).toEqual({ state: 'dispatching' });
          yield { type: 'done', data: {} } as StreamEvent;
        },
      ]);
      const restartedRegistry = new RuntimeRegistry();
      restartedRegistry.setDb(db);
      restartedRegistry.register(coldRuntime);
      service = new PrivateSessionMessageAcceptanceService(
        db,
        queue,
        [adapter(runtimeType)],
        'boot-b',
        () => NOW
      );
      setPrivateSessionMessageAcceptanceService(service);

      expect(coldRuntime.ensureSession).not.toHaveBeenCalled();
      expect(coldRuntime.sendMessage).not.toHaveBeenCalled();
      const recoveredSessions = service.listAcceptedSessionIds();
      expect(recoveredSessions).toEqual([SESSION_ID]);
      for (const sessionId of recoveredSessions) {
        const resolvedRuntime = await restartedRegistry.resolveForSession(sessionId);
        const agentPath = await restartedRegistry.getSessionAgentPath(sessionId);
        expect(resolvedRuntime.type).toBe(runtimeType);
        expect(agentPath).toBe('/agents/researcher');
        expect(
          adoptAcceptedPrivateMessages({
            sessionId,
            cwd: agentPath ?? undefined,
            projector: getOrCreateProjector(sessionId),
            runtime: resolvedRuntime,
          })
        ).toBe(1);
      }
      await settle();

      expect(coldRuntime.ensureSession).not.toHaveBeenCalled();
      expect(coldRuntime.sendMessage).toHaveBeenCalledTimes(1);
      expect(coldRuntime.sendMessage).toHaveBeenCalledWith(
        SESSION_ID,
        'Access to Gmail is ready.',
        expect.objectContaining({ cwd: '/agents/researcher' })
      );
      expect(
        db
          .select()
          .from(sessionMessageAcceptanceReceipts)
          .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
          .get()
      ).toMatchObject({
        originRuntime: runtimeType,
        originAgentPath: '/agents/researcher',
        dispatchBootEpoch: 'boot-b',
        state: 'settled',
      });
    }
  );

  it.each([
    'accepted',
    'dispatching',
    'turn_started',
    'settled',
    'cancelled',
    'outcome_unknown',
  ] as const)('keeps a receipt-linked %s row out of generic queue recovery', (state) => {
    const ref = seedRequest(db, state);
    const accepted = service.accept(ref);
    db.update(sessionMessageAcceptanceReceipts)
      .set({ state })
      .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
      .run();

    expect(
      adoptQueuedMessages({
        sessionId: SESSION_ID,
        projector: getOrCreateProjector(SESSION_ID),
        runtime,
      })
    ).toBe(0);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(queue.list(SESSION_ID)).toHaveLength(1);
  });

  it('cancels before the runtime effect when exact event access changes after preparation', async () => {
    db.insert(connectorProviderInstances)
      .values({
        id: 'provider-1',
        type: 'test',
        mode: 'byo',
        displayName: 'Test provider',
        custody: 'self-host',
        capabilityJson: '{}',
        executionConfigGeneration: 1,
        ownerKind: 'local_install',
        ownerId: 'install-1',
        status: 'available',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    db.insert(connections)
      .values({
        id: 'connection-1',
        providerInstanceId: 'provider-1',
        externalAccountRef: 'private-account',
        toolkit: 'gmail',
        label: 'Work mail',
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
        id: 'revision-1',
        providerInstanceId: 'provider-1',
        toolkit: 'gmail',
        operationSlug: 'gmail.read',
        toolkitVersion: '1',
        schemaHash: 'schema-hash',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        providerRevisionRef: 'hosted-revision',
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-1',
        subjectType: 'agent',
        subjectId: 'agent-1',
        agentId: 'agent-1',
        connectionId: 'connection-1',
        operationRevisionId: 'revision-1',
        createdBy: 'local_install:install-1',
        createdAt: NOW.toISOString(),
      })
      .run();
    const ref = seedRequest(db, 'event-revoked');
    const eventScope = {
      connectionId: 'connection-1',
      definitionId: 'definition-1',
      filter: {},
      agentId: 'agent-1',
      destination: { kind: 'agent', id: 'agent-1' },
    } as const;
    db.update(connectorReviewRequests)
      .set({
        ownerKind: 'local_install',
        ownerId: 'install-1',
        resolutionJson: JSON.stringify({
          version: 1,
          decision: {
            decision: 'approved',
            connectionId: 'connection-1',
            operationRevisionIds: ['revision-1'],
            eventScopes: [eventScope],
          },
        }),
      })
      .where(eq(connectorReviewRequests.id, 'review-event-revoked'))
      .run();
    db.update(connectorAgentRequests)
      .set({
        requestedEventsJson: '["gmail.message_received"]',
        resolvedEventsJson: JSON.stringify({
          version: 1,
          selections: [
            {
              subscriptionId: 'subscription-1',
              scopeVersion: 1,
              definitionId: 'definition-1',
              eventScopeHash: 'a'.repeat(64),
            },
          ],
          appliedEventScopeHash: 'b'.repeat(64),
        }),
      })
      .where(eq(connectorAgentRequests.id, ref.requestId))
      .run();
    let eventReady = true;
    const eventGrants: ConnectorEventGrantPort = {
      describe: () => [{ definitionId: 'definition-1', eventType: 'gmail.message_received' }],
      approve: async () => ({
        state: 'ready',
        selections: [],
        appliedEventScopeHash: 'b'.repeat(64),
      }),
      ready: () => eventReady,
    };
    const source = new ConnectorAgentRequestSourceAdapter(
      db,
      {
        revalidateOrigin: async () => true,
        revalidateOriginSync: () => true,
        resolveAgent: () => ({ id: 'agent-1', displayName: 'Researcher' }),
      },
      'boot-a',
      eventGrants
    );
    const revokeAfterPrepare: PrivateSessionMessageSourceAdapter<AgentRequestRef> = {
      kind: source.kind,
      consume: (tx, sourceRef, now) => source.consume(tx, sourceRef, now),
      prepare: async (receipt) => {
        const prepared = await source.prepare(receipt);
        eventReady = false;
        return prepared;
      },
      revalidate: (tx, receipt, prepared) => source.revalidate(tx, receipt, prepared),
      onCancelled: (tx, receipt) => source.onCancelled(tx, receipt),
    };
    service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [revokeAfterPrepare],
      'boot-a',
      () => NOW
    );
    setPrivateSessionMessageAcceptanceService(service);
    const accepted = service.accept(ref);

    expect(
      adoptAcceptedPrivateMessages({
        sessionId: SESSION_ID,
        projector: getOrCreateProjector(SESSION_ID),
        runtime,
      })
    ).toBe(1);
    await settle();

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(queue.list(SESSION_ID)).toEqual([]);
    expect(
      db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toMatchObject({
      state: 'cancelled',
      cancellationCode: 'authority_changed_before_dispatch',
    });
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, ref.requestId))
        .get()
    ).toMatchObject({ resumeState: 'cancelled' });
  });
});
