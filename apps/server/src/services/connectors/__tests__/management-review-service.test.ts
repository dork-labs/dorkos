/** Owner binding, idempotency, and restart-safe review outcome tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
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
import { ConnectorFlowBindings } from '../flow-bindings.js';
import {
  ConnectorManagementReviewError,
  ConnectorManagementReviewService,
  type ConnectorManagementActionApplier,
} from '../management-review-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const NOW = new Date('2026-09-06T12:00:00.000Z');

describe('ConnectorManagementReviewService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let flowBindings: ConnectorFlowBindings;
  let actions: ConnectorManagementActionApplier;
  let service: ConnectorManagementReviewService;
  let nextId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    registry.register(
      new FakeConnectorProvider({ instanceId: PROVIDER_ID, toolkitVersion: 'current-v2' }),
      'material-a'
    );
    db.update(connectorProviderInstances)
      .set({ ownerKind: 'local_install', ownerId: OWNER.installationId })
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
        operationSlug: 'gmail.messages.list',
        toolkitVersion: 'current-v2',
        schemaHash: 'sha256:revision-a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
    flowBindings = new ConnectorFlowBindings(
      () => `public-flow-${nextId}`,
      100,
      (provider) => registry.providerExecutionConfigGeneration(provider)
    );
    actions = { apply: vi.fn().mockResolvedValue(undefined) };
    nextId = 0;
    service = makeService('boot-a', flowBindings);
  });

  function makeService(bootEpoch: string, bindings: ConnectorFlowBindings) {
    return new ConnectorManagementReviewService({
      db,
      registry,
      flowBindings: bindings,
      actions,
      bootEpoch,
      resolveAgent: (_owner, agentId) =>
        agentId === 'agent-a' ? { displayName: 'Research Agent' } : undefined,
      now: () => NOW,
      createId: () => `review-${++nextId}`,
    });
  }

  it('returns the same unresolved review for an equivalent program idempotency key', () => {
    const requester = { kind: 'program', requesterId: 'key-a', owner: OWNER } as const;
    const request = {
      action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID } as const,
      idempotencyKey: 'same-command',
    };
    const first = service.create(requester, request);
    expect(service.create(requester, request)).toEqual(first);

    expect(() =>
      service.create(requester, {
        action: { version: 1, kind: 'resume', connectionId: CONNECTION_ID },
        idempotencyKey: 'same-command',
      })
    ).toThrowError(ConnectorManagementReviewError);
    expect(() =>
      service.create(requester, {
        action: {
          version: 1,
          kind: 'set_agent_access',
          connectionId: CONNECTION_ID,
          agentId: 'agent-a',
          operationRevisionIds: ['revision-missing'],
        },
        idempotencyKey: 'invalid-grant',
      })
    ).toThrowError(ConnectorManagementReviewError);
  });

  it('returns only lifecycle state to the exact program requester', async () => {
    const requester = { kind: 'program', requesterId: 'key-a', owner: OWNER } as const;
    const review = service.create(requester, {
      action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
      idempotencyKey: 'program-status',
    });
    expect(service.getProgramStatus(requester, review.reviewRequestId)).toEqual({
      reviewRequestId: review.reviewRequestId,
      reviewUrl: `/connections?review=${review.reviewRequestId}`,
      state: 'pending',
      targetStatus: 'available',
      expiresAt: '2026-09-06T12:15:00.000Z',
    });
    expect(() =>
      service.getProgramStatus(
        { kind: 'program', requesterId: 'key-b', owner: OWNER },
        review.reviewRequestId
      )
    ).toThrowError(expect.objectContaining({ code: 'review_not_found' }));
    expect(() =>
      service.getProgramStatus(
        { kind: 'program', requesterId: 'key-a', owner: FOREIGN_OWNER },
        review.reviewRequestId
      )
    ).toThrowError(expect.objectContaining({ code: 'review_not_found' }));

    await service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' });
    expect(service.getProgramStatus(requester, review.reviewRequestId)).toEqual({
      reviewRequestId: review.reviewRequestId,
      reviewUrl: `/connections?review=${review.reviewRequestId}`,
      state: 'approved',
      targetStatus: 'available',
      resolvedAt: NOW.toISOString(),
      outcome: 'applied',
      expiresAt: '2026-09-06T12:15:00.000Z',
    });
  });

  it('projects a stale target as unavailable without exposing owner context', () => {
    const requester = { kind: 'program', requesterId: 'key-a', owner: OWNER } as const;
    const review = service.create(requester, {
      action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
      idempotencyKey: 'stale-program-status',
    });
    registry.register(
      new FakeConnectorProvider({ instanceId: PROVIDER_ID, toolkitVersion: 'current-v2' }),
      'material-b'
    );

    expect(service.getProgramStatus(requester, review.reviewRequestId)).toEqual({
      reviewRequestId: review.reviewRequestId,
      reviewUrl: `/connections?review=${review.reviewRequestId}`,
      state: 'pending',
      targetStatus: 'unavailable',
      expiresAt: '2026-09-06T12:15:00.000Z',
    });
  });

  it('keeps connect approval distinct from connection and returns one opaque flow', async () => {
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: {
          version: 1,
          kind: 'connect',
          providerInstanceId: PROVIDER_ID,
          toolkit: 'gmail',
        },
        idempotencyKey: 'connect-gmail',
      }
    );

    const approved = await service.resolve(OWNER, review.reviewRequestId, {
      decision: 'approved',
    });
    expect(approved.review).toMatchObject({
      state: 'approved',
      resolution: {
        kind: 'connect_authentication_required',
        reviewRequestId: review.reviewRequestId,
        authentication: { flowId: 'public-flow-1' },
      },
    });
    expect(
      service.getProgramStatus(
        { kind: 'program', requesterId: 'key-a', owner: OWNER },
        review.reviewRequestId
      )
    ).toMatchObject({ state: 'approved', outcome: 'authentication_required' });
    expect(await service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' })).toEqual(
      approved
    );
  });

  it('persists exact owner-visible review context instead of substituting later state', () => {
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: {
          version: 1,
          kind: 'set_agent_access',
          connectionId: CONNECTION_ID,
          agentId: 'agent-a',
          operationRevisionIds: ['revision-a'],
        },
        idempotencyKey: 'grant-read',
      }
    );
    expect(review.context).toEqual({
      kind: 'set_agent_access',
      connection: {
        connectionId: CONNECTION_ID,
        label: 'Work Gmail',
        toolkit: 'gmail',
        status: 'active',
        custody: 'managed',
        providerDisplayName: 'fake-connector',
        providerStatus: 'available',
        reconciliationStatus: 'ready',
      },
      agent: { agentId: 'agent-a', displayName: 'Research Agent' },
      requestedOperations: [
        {
          operationRevisionId: 'revision-a',
          operationSlug: 'gmail.messages.list',
          toolkitVersion: 'current-v2',
          capabilityClassification: 'read',
        },
      ],
    });

    db.update(connections)
      .set({ label: 'Renamed later' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    expect(service.get(OWNER, review.reviewRequestId).context).toEqual(review.context);
  });

  it('keeps unavailable targets reviewable for denial but refuses approval', async () => {
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
        idempotencyKey: 'pause-before-delete',
      }
    );
    db.update(connections)
      .set({ lifecycleState: 'disconnected', status: 'revoked', enabled: false })
      .where(eq(connections.id, CONNECTION_ID))
      .run();

    expect(service.get(OWNER, review.reviewRequestId)).toMatchObject({
      state: 'pending',
      targetStatus: 'unavailable',
      context: { kind: 'pause', connection: { label: 'Work Gmail' } },
    });
    await expect(
      service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' })
    ).rejects.toMatchObject({ code: 'target_not_found' });
    await expect(
      service.resolve(OWNER, review.reviewRequestId, { decision: 'denied' })
    ).resolves.toMatchObject({ review: { state: 'denied' } });
  });

  it('still expires a genuinely pending request after its review window', () => {
    let clock = NOW;
    service = new ConnectorManagementReviewService({
      db,
      registry,
      flowBindings,
      actions,
      bootEpoch: 'boot-a',
      resolveAgent: (_owner, agentId) =>
        agentId === 'agent-a' ? { displayName: 'Research Agent' } : undefined,
      now: () => clock,
      createId: () => `review-${++nextId}`,
    });
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
        idempotencyKey: 'pending-expiry',
      }
    );
    clock = new Date('2026-09-06T12:16:00.000Z');

    expect(service.get(OWNER, review.reviewRequestId)).toMatchObject({ state: 'expired' });
  });

  it('keeps pause and disconnect reviewable when a provider is unavailable', () => {
    db.update(connections).set({ enabled: false }).where(eq(connections.id, CONNECTION_ID)).run();
    db.update(connectorProviderInstances)
      .set({ status: 'unavailable' })
      .where(eq(connectorProviderInstances.id, PROVIDER_ID))
      .run();

    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: { version: 1, kind: 'disconnect', connectionId: CONNECTION_ID },
        idempotencyKey: 'disconnect-unavailable',
      }
    );
    expect(review.context).toMatchObject({
      kind: 'disconnect',
      affectedAgentCount: 1,
      connection: { status: 'paused', providerStatus: 'unavailable' },
      affectedOperations: [{ operationRevisionId: 'revision-a' }],
    });
  });

  it('expires an approved connect review after restart instead of replaying startConnect', async () => {
    const provider = registry.resolveProviderInstance(PROVIDER_ID)!;
    const start = vi.spyOn(provider, 'startConnect');
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: {
          version: 1,
          kind: 'connect',
          providerInstanceId: PROVIDER_ID,
          toolkit: 'gmail',
        },
        idempotencyKey: 'connect-gmail',
      }
    );
    await service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' });
    expect(start).toHaveBeenCalledTimes(1);

    const restarted = makeService('boot-b', new ConnectorFlowBindings());
    expect(restarted.get(OWNER, review.reviewRequestId).state).toBe('expired');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('expires an approved connect flow when provider material changes', async () => {
    const oldProvider = registry.resolveProviderInstance(PROVIDER_ID)!;
    const poll = vi.spyOn(oldProvider, 'pollConnect');
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: {
          version: 1,
          kind: 'connect',
          providerInstanceId: PROVIDER_ID,
          toolkit: 'gmail',
        },
        idempotencyKey: 'connect-before-rotation',
      }
    );
    const approved = await service.resolve(OWNER, review.reviewRequestId, {
      decision: 'approved',
    });
    expect(approved.review.state).toBe('approved');

    registry.register(
      new FakeConnectorProvider({ instanceId: PROVIDER_ID, toolkitVersion: 'current-v2' }),
      'material-b'
    );
    expect(service.get(OWNER, review.reviewRequestId).state).toBe('expired');
    expect(poll).not.toHaveBeenCalled();
    expect(db.select().from(connections).all()).toHaveLength(1);
  });

  it('applies a non-connect action once and denies a foreign owner uniformly', async () => {
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
        idempotencyKey: 'pause-account',
      }
    );
    await expect(
      service.resolve(FOREIGN_OWNER, review.reviewRequestId, { decision: 'approved' })
    ).rejects.toMatchObject({ code: 'review_not_found' });

    const result = await service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' });
    expect(result.review).toMatchObject({ state: 'approved', resolution: { kind: 'applied' } });
    expect(actions.apply).toHaveBeenCalledTimes(1);
    await service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' });
    expect(actions.apply).toHaveBeenCalledTimes(1);
  });

  it('recovers a possibly applied action as unknown when its terminal receipt cannot persist', async () => {
    actions = {
      apply: async () => {
        db.update(connections)
          .set({ enabled: false })
          .where(eq(connections.id, CONNECTION_ID))
          .run();
      },
    };
    service = makeService('boot-a', flowBindings);
    const requester = { kind: 'program', requesterId: 'key-a', owner: OWNER } as const;
    const review = service.create(requester, {
      action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
      idempotencyKey: 'pause-receipt-race',
    });
    db.$client.exec(`
      CREATE TRIGGER reject_connector_review_receipt
      BEFORE UPDATE OF resolution_json ON connector_review_requests
      WHEN NEW.resolution_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'receipt rejected');
      END;
    `);

    await expect(
      service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' })
    ).rejects.toMatchObject({ code: 'action_failed' });
    expect(
      db.select().from(connections).where(eq(connections.id, CONNECTION_ID)).get()?.enabled
    ).toBe(false);
    expect(service.get(OWNER, review.reviewRequestId)).toMatchObject({
      state: 'approved',
      resolution: { kind: 'outcome_unknown' },
    });
    expect(service.getProgramStatus(requester, review.reviewRequestId)).toMatchObject({
      state: 'approved',
      outcome: 'outcome_unknown',
    });
    expect(
      makeService('boot-b', new ConnectorFlowBindings()).get(OWNER, review.reviewRequestId)
    ).toMatchObject({ state: 'approved', resolution: { kind: 'outcome_unknown' } });
    expect(
      service.create(requester, {
        action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
        idempotencyKey: 'pause-receipt-race',
      })
    ).toMatchObject({ state: 'approved', resolution: { kind: 'outcome_unknown' } });
  });

  it('reports resolving only while the approved action is actively in flight', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    actions = { apply: vi.fn(() => held) };
    service = makeService('boot-a', flowBindings);
    const review = service.create(
      { kind: 'program', requesterId: 'key-a', owner: OWNER },
      {
        action: { version: 1, kind: 'pause', connectionId: CONNECTION_ID },
        idempotencyKey: 'pause-in-flight',
      }
    );
    const denied = service.create(
      { kind: 'program', requesterId: 'key-b', owner: OWNER },
      {
        action: { version: 1, kind: 'resume', connectionId: CONNECTION_ID },
        idempotencyKey: 'other-resolved-review',
      }
    );
    await service.resolve(OWNER, denied.reviewRequestId, { decision: 'denied' });

    const resolving = service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' });
    await vi.waitFor(() => expect(actions.apply).toHaveBeenCalledTimes(1));
    expect(service.get(OWNER, review.reviewRequestId)).toMatchObject({ state: 'resolving' });
    expect(service.list(OWNER, 'resolved')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewRequestId: review.reviewRequestId, state: 'resolving' }),
        expect.objectContaining({ reviewRequestId: denied.reviewRequestId, state: 'denied' }),
      ])
    );
    expect(
      service.getProgramStatus(
        { kind: 'program', requesterId: 'key-a', owner: OWNER },
        review.reviewRequestId
      )
    ).toMatchObject({ state: 'resolving' });
    await expect(
      service.resolve(OWNER, review.reviewRequestId, { decision: 'approved' })
    ).resolves.toMatchObject({ review: { state: 'resolving' } });
    expect(actions.apply).toHaveBeenCalledTimes(1);
    release();
    await expect(resolving).resolves.toMatchObject({
      review: { state: 'approved', resolution: { kind: 'applied' } },
    });
  });

  it('looks up the same idempotency key before revalidating a target changed by the action', () => {
    const requester = { kind: 'program', requesterId: 'key-a', owner: OWNER } as const;
    const request = {
      action: { version: 1, kind: 'disconnect', connectionId: CONNECTION_ID } as const,
      idempotencyKey: 'disconnect-unknown',
    };
    const review = service.create(requester, request);
    db.update(connectorReviewRequests)
      .set({
        state: 'approved',
        resolvedAt: NOW.toISOString(),
        resolutionSummary: 'applying:old-boot',
      })
      .where(eq(connectorReviewRequests.id, review.reviewRequestId))
      .run();
    db.update(connections)
      .set({ lifecycleState: 'disconnected', status: 'revoked', enabled: false })
      .where(eq(connections.id, CONNECTION_ID))
      .run();

    expect(service.create(requester, request)).toMatchObject({
      state: 'approved',
      targetStatus: 'unavailable',
      resolution: { kind: 'outcome_unknown' },
    });
  });
});
