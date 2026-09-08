import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectorAgentRequests,
  connectorReviewRequests,
  createDb,
  and,
  eq,
  isNull,
  lte,
  or,
  runMigrations,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { MessageQueueStore } from '../message-queue-store.js';
import {
  PrivateSessionMessageAcceptanceService,
  type PreparedPrivateSessionMessage,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageSourceRef,
} from '../private-messages/acceptance.js';

const NOW = new Date('2026-09-07T12:00:00.000Z');
type AgentRequestRef = Extract<PrivateSessionMessageSourceRef, { kind: 'connector_agent_request' }>;

const REF: AgentRequestRef = {
  kind: 'connector_agent_request',
  requestId: 'request-1',
  sourceGeneration: 'generation-1',
  resumeToken: 'opaque-token',
};

function seedRequest(
  db: Db,
  id = 'request-1',
  overrides: Partial<typeof connectorAgentRequests.$inferInsert> = {}
): void {
  db.insert(connectorReviewRequests)
    .values({
      id: `review-${id}`,
      actionKind: 'agent_connection_request',
      actionVersion: 1,
      requesterKind: 'agent',
      requesterId: 'agent-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      authorityBindingDigest: 'sha256:authority',
      targetKind: 'service',
      targetId: 'gmail',
      actionPayloadJson: '{}',
      state: 'approved',
      expiresAt: '2026-09-08T00:00:00.000Z',
      idempotencyKey: id,
      createdAt: NOW.toISOString(),
    })
    .run();
  db.insert(connectorAgentRequests)
    .values({
      id,
      reviewRequestId: `review-${id}`,
      agentId: 'agent-1',
      sessionId: 'session-1',
      serviceSlug: 'gmail',
      requestedOperationsJson: '["gmail.read"]',
      requestedEventsJson: '[]',
      reason: 'Read new mail',
      resumeState: 'ready',
      sourceGeneration: 'generation-1',
      resumeToken: 'opaque-token',
      originRuntime: 'claude-code',
      originAgentPath: '/agents/researcher',
      originAuthorityDigest: 'sha256:authority',
      outcome: 'granted',
      resolvedConnectionId: 'connection-1',
      resolvedOperationRevisionIdsJson: '["revision-1"]',
      resolvedEventsJson: '[]',
      resolvedAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      ...overrides,
    })
    .run();
}

function requestAdapter(db: Db): PrivateSessionMessageSourceAdapter<AgentRequestRef> {
  return {
    kind: 'connector_agent_request',
    consume(tx, ref, now) {
      const changed = tx
        .update(connectorAgentRequests)
        .set({ resumeState: 'resumed' })
        .where(
          and(
            eq(connectorAgentRequests.id, ref.requestId),
            eq(connectorAgentRequests.resumeState, 'ready'),
            eq(connectorAgentRequests.sourceGeneration, ref.sourceGeneration),
            eq(connectorAgentRequests.resumeToken, ref.resumeToken),
            or(
              isNull(connectorAgentRequests.liveHoldUntil),
              lte(connectorAgentRequests.liveHoldUntil, now)
            )
          )
        )
        .run().changes;
      if (changed !== 1) throw new Error('source claim is no longer current');
      return {
        sourceKind: ref.kind,
        sourceId: ref.requestId,
        sourceGeneration: ref.sourceGeneration,
        sessionId: 'session-1',
        agentId: 'agent-1',
        originRuntime: 'claude-code',
        originAgentPath: '/agents/researcher',
        originAuthorityDigest: 'sha256:authority',
        queuePlaceholder: '[Private connection update]',
      };
    },
    async prepare(receipt): Promise<PreparedPrivateSessionMessage> {
      return {
        sourceKind: 'connector_agent_request',
        sourceId: receipt.sourceId,
        sourceGeneration: receipt.sourceGeneration,
        content: 'Connection access was approved for Gmail.',
      };
    },
    revalidate(_tx, receipt, prepared) {
      const source = db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, receipt.sourceId))
        .get();
      if (
        !source ||
        source.resumeState !== 'resumed' ||
        source.sourceGeneration !== prepared.sourceGeneration ||
        source.originAuthorityDigest !== receipt.originAuthorityDigest
      ) {
        throw new Error('authority changed');
      }
    },
  };
}

describe('PrivateSessionMessageAcceptanceService', () => {
  let db: Db;
  let queue: MessageQueueStore;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    queue = new MessageQueueStore(db);
    seedRequest(db);
  });

  it('atomically consumes the source, queues a placeholder, and deduplicates by source generation', () => {
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );

    const first = service.accept(REF);
    const repeated = service.accept(REF);

    expect(first.created).toBe(true);
    expect(first.queueRecord?.content).toBe('[Private connection update]');
    expect(repeated).toMatchObject({ created: false, receipt: { id: first.receipt.id } });
    expect(queue.list('session-1')).toHaveLength(1);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, 'request-1'))
        .get()?.resumeState
    ).toBe('resumed');
  });

  it('claims once, removes the queue row at turn start, and keeps the settled receipt', async () => {
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );
    const accepted = service.accept(REF);
    const prepared = await service.prepare(accepted.receipt.id);

    const claim = service.claim(accepted.receipt.id, prepared);
    expect(claim.content).toBe('Connection access was approved for Gmail.');
    expect(() => service.claim(accepted.receipt.id, prepared)).toThrow(/no longer available/);
    expect(queue.list('session-1')).toHaveLength(1);

    service.markTurnStarted(accepted.receipt.id, 42);
    service.settle(accepted.receipt.id, 'ok');

    expect(queue.list('session-1')).toEqual([]);
    expect(
      db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toMatchObject({ state: 'settled', turnStartSeq: 42, settleOutcome: 'completed' });
    const repeated = service.accept(REF);
    expect(repeated.created).toBe(false);
    expect(repeated.queueRecord).toBeUndefined();
  });

  it('rolls source consumption back when the accepted identity does not match', () => {
    const adapter = requestAdapter(db);
    const mismatchedAdapter: PrivateSessionMessageSourceAdapter<AgentRequestRef> = {
      ...adapter,
      consume(tx, ref, now) {
        return { ...adapter.consume(tx, ref, now), sourceGeneration: 'different' };
      },
    };
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [mismatchedAdapter],
      'boot-a',
      () => NOW
    );

    expect(() => service.accept(REF)).toThrow(/identity changed/);
    expect(queue.list('session-1')).toEqual([]);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, 'request-1'))
        .get()?.resumeState
    ).toBe('ready');
  });

  it('rejects a stale claim token without consuming the immutable generation', () => {
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );

    expect(() => service.accept({ ...REF, resumeToken: 'stale-token' })).toThrow(
      /no longer current/
    );
    expect(queue.list('session-1')).toEqual([]);
    expect(
      db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, REF.requestId))
        .get()?.resumeState
    ).toBe('ready');
  });

  it('cannot consume a source while its live-hold claim is still current', () => {
    db.update(connectorAgentRequests)
      .set({
        liveHoldBootEpoch: 'boot-a',
        liveHoldUntil: '2026-09-07T12:01:00.000Z',
      })
      .where(eq(connectorAgentRequests.id, REF.requestId))
      .run();
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );

    expect(() => service.accept(REF)).toThrow(/no longer current/);
    expect(queue.list('session-1')).toEqual([]);
  });

  it('quarantines a prior boot claim and never leaves its queue row adoptable', async () => {
    const firstBoot = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );
    const accepted = firstBoot.accept(REF);
    firstBoot.claim(accepted.receipt.id, await firstBoot.prepare(accepted.receipt.id));

    const nextBoot = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-b',
      () => NOW
    );
    expect(nextBoot.recoverUnobservedAttempts()).toBe(1);

    expect(queue.list('session-1')).toEqual([]);
    expect(
      db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toMatchObject({
      state: 'outcome_unknown',
      cancellationCode: 'server_restarted_after_dispatch_claim',
    });
  });

  it('lists a bounded set of distinct sessions that still have accepted receipts', async () => {
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );
    const accepted = service.accept(REF);
    db.insert(sessionMessageAcceptanceReceipts)
      .values([
        {
          ...accepted.receipt,
          id: 'receipt-session-1-second',
          sourceId: 'request-session-1-second',
          queueMessageId: 'queue-session-1-second',
        },
        {
          ...accepted.receipt,
          id: 'receipt-session-2',
          sourceId: 'request-session-2',
          queueMessageId: 'queue-session-2',
          sessionId: 'session-2',
        },
        {
          ...accepted.receipt,
          id: 'receipt-session-3',
          sourceId: 'request-session-3',
          queueMessageId: 'queue-session-3',
          sessionId: 'session-3',
        },
      ])
      .run();

    expect(service.listAcceptedSessionIds(2)).toHaveLength(2);
    expect(new Set(service.listAcceptedSessionIds())).toEqual(
      new Set(['session-1', 'session-2', 'session-3'])
    );

    service.claim(accepted.receipt.id, await service.prepare(accepted.receipt.id));
    expect(service.listAcceptedSessionIds()).toContain('session-1');
  });

  it('pages past a stuck first recovery batch while keeping every scan bounded', () => {
    const service = new PrivateSessionMessageAcceptanceService(
      db,
      queue,
      [requestAdapter(db)],
      'boot-a',
      () => NOW
    );
    const accepted = service.accept(REF);
    for (let index = 0; index < 100; index += 1) {
      db.insert(sessionMessageAcceptanceReceipts)
        .values({
          ...accepted.receipt,
          id: `receipt-recovery-${index}`,
          sourceId: `request-recovery-${index}`,
          queueMessageId: `queue-recovery-${index}`,
          sessionId: `session-recovery-${String(index).padStart(3, '0')}`,
        })
        .run();
    }

    const reached = new Set<string>();
    let cursor: string | undefined;
    for (let scan = 0; scan < 3; scan += 1) {
      const page = service.listAcceptedSessionIds(100, cursor);
      expect(page.length).toBeLessThanOrEqual(100);
      page.forEach((sessionId) => reached.add(sessionId));
      cursor = page.length === 100 ? page.at(-1) : undefined;
    }

    expect(reached.size).toBe(101);
  });
});
