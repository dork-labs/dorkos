import { createHash } from 'node:crypto';
import {
  connectorAgentRequests,
  connectorReviewRequests,
  createDb,
  eq,
  runMigrations,
  sessionMetadata,
  type Db,
} from '@dorkos/db';
import { CanvasDocumentStore } from '../../canvas-document-store.js';
import { CanvasService } from '../../canvas-service.js';
import { DocChannelStore } from '../store.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import {
  PrivateSessionMessageAcceptanceService,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageSourceRef,
} from '../../../session/private-messages/acceptance.js';

export const NOW = '2026-10-01T12:00:00.000Z';
export const FROM = 'session:session-1';
export const TO = 'session:canonical';
export function originDigest(sessionId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        owner: 'installation',
        sessionId,
        agentId: 'agent-1',
        runtime: 'claude-code',
        agentPath: '/agents/one',
      })
    )
    .digest('hex');
}
export function seedAuthority(db: Db): void {
  db.$client
    .prepare(
      'INSERT INTO agents (id,name,runtime,project_path,registered_at,updated_at) VALUES (?,?,?,?,?,?)'
    )
    .run('agent-1', 'one', 'claude-code', '/agents/one', NOW, NOW);
  db.insert(sessionMetadata)
    .values([
      { sessionId: 'session-1', runtime: 'claude-code', agentPath: '/agents/one', createdAt: NOW },
      { sessionId: 'canonical', runtime: 'claude-code', agentPath: '/agents/one', createdAt: NOW },
    ])
    .run();
}
export function seedSource(db: Db): void {
  db.insert(connectorReviewRequests)
    .values({
      id: 'review',
      actionKind: 'agent_connection_request',
      actionVersion: 1,
      requesterKind: 'agent',
      requesterId: 'agent-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      authorityBindingDigest: originDigest('session-1'),
      targetKind: 'service',
      targetId: 'gmail',
      actionPayloadJson: '{}',
      state: 'approved',
      expiresAt: '2026-10-02T00:00:00.000Z',
      idempotencyKey: 'request',
      createdAt: NOW,
    })
    .run();
  db.insert(connectorAgentRequests)
    .values({
      id: 'request',
      reviewRequestId: 'review',
      agentId: 'agent-1',
      sessionId: 'session-1',
      serviceSlug: 'gmail',
      requestedAccess: 'read',
      requestedEventsJson: '[]',
      reason: 'Read mail',
      resumeState: 'ready',
      sourceGeneration: 'generation-1',
      resumeToken: 'token',
      originRuntime: 'claude-code',
      originAgentPath: '/agents/one',
      originAuthorityDigest: originDigest('session-1'),
      outcome: 'granted',
      resolvedConnectionId: 'connection',
      resolvedOperationRevisionIdsJson: '[]',
      resolvedEventsJson: '[]',
      resolvedAt: NOW,
      createdAt: NOW,
    })
    .run();
}
export function sourceAdapter(
  _db: Db
): PrivateSessionMessageSourceAdapter<
  Extract<PrivateSessionMessageSourceRef, { kind: 'connector_agent_request' }>
> {
  return {
    kind: 'connector_agent_request',
    consume(tx, ref) {
      const source = tx
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, ref.requestId))
        .get()!;
      if (
        source.resumeState !== 'ready' ||
        source.resumeToken !== ref.resumeToken ||
        source.sourceGeneration !== ref.sourceGeneration
      )
        throw new Error('source changed');
      tx.update(connectorAgentRequests)
        .set({ resumeState: 'resumed' })
        .where(eq(connectorAgentRequests.id, ref.requestId))
        .run();
      return {
        sourceKind: ref.kind,
        sourceId: ref.requestId,
        sourceGeneration: ref.sourceGeneration,
        sessionId: source.sessionId,
        agentId: source.agentId,
        originRuntime: source.originRuntime!,
        originAgentPath: source.originAgentPath!,
        originAuthorityDigest: source.originAuthorityDigest!,
        queuePlaceholder: '[Private connection update]',
      };
    },
    async prepare(receipt) {
      return {
        sourceKind: 'connector_agent_request',
        sourceId: receipt.sourceId,
        sourceGeneration: receipt.sourceGeneration,
        content: 'Private protected source content',
      };
    },
    revalidate(tx, receipt) {
      const source = tx
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, receipt.sourceId))
        .get()!;
      if (
        source.sessionId !== receipt.sessionId ||
        source.originAuthorityDigest !== receipt.originAuthorityDigest ||
        source.sourceGeneration !== receipt.sourceGeneration
      )
        throw new Error('authority changed');
    },
    rebindAccepted(tx, receipt, toSessionId) {
      const source = tx
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, receipt.sourceId))
        .get()!;
      if (
        source.sessionId !== receipt.sessionId ||
        source.agentId !== receipt.agentId ||
        source.originRuntime !== receipt.originRuntime ||
        source.originAgentPath !== receipt.originAgentPath ||
        source.originAuthorityDigest !== receipt.originAuthorityDigest ||
        source.sourceGeneration !== receipt.sourceGeneration
      )
        return undefined;
      const digest = originDigest(toSessionId);
      tx.update(connectorAgentRequests)
        .set({ sessionId: toSessionId, originAuthorityDigest: digest })
        .where(eq(connectorAgentRequests.id, source.id))
        .run();
      return digest;
    },
  };
}
export function harness(file = ':memory:'): {
  db: Db;
  queue: MessageQueueStore;
  receipts: PrivateSessionMessageAcceptanceService;
  documents: CanvasDocumentStore;
  canvas: CanvasService;
  frames: unknown[];
  store: DocChannelStore;
} {
  const db = createDb(file);
  runMigrations(db);
  seedAuthority(db);
  const queue = new MessageQueueStore(db);
  const receipts = new PrivateSessionMessageAcceptanceService(
    db,
    queue,
    [sourceAdapter(db)],
    'test-boot',
    () => new Date(NOW)
  );
  const documents = new CanvasDocumentStore(db, { receipts, now: () => NOW });
  const frames: unknown[] = [];
  const canvas = new CanvasService({
    documents,
    channels: { publish: (_scope, frame) => frames.push(frame), viewers: () => 0 },
    now: () => Date.parse(NOW),
  });
  return { db, queue, receipts, documents, canvas, frames, store: new DocChannelStore(db) };
}
export function pending(h: ReturnType<typeof harness>, documentId: string, receiptId?: string) {
  h.store.insertGrant({
    grantId: `grant-${documentId}`,
    documentId,
    routeId: 'route',
    normalizedRoute: { on: 'task.*', to: 'agent:owner' },
    routeHash: 'a'.repeat(64),
    declarationHash: 'b'.repeat(64),
    approvedBy: 'owner',
    approvalEvidence: {},
    allowedTypes: ['task.done'],
    limits: {},
    createdAt: NOW,
  });
  h.store.appendEvent({
    documentId,
    eventId: 'event',
    direction: 'upstream',
    type: 'task.done',
    payload: { private: true },
    envelopeHash: 'c'.repeat(64),
    receivedAt: NOW,
    provenance: {},
  });
  h.store.insertBatch({
    batchId: `batch-${documentId}`,
    documentId,
    scope: FROM,
    routeId: 'route',
    grantId: `grant-${documentId}`,
    grantRevision: 1,
    generation: 'batch-generation',
    inputEventIds: ['event'],
    effectivePayload: { private: true },
    dueAt: NOW,
    status: receiptId ? 'accepted' : 'pending',
    admissionReceiptId: receiptId ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  h.store.insertDelivery({
    documentId,
    eventId: 'event',
    routeId: 'route',
    batchId: `batch-${documentId}`,
    status: 'pending',
    updatedAt: NOW,
  });
}
export function accept(h: ReturnType<typeof harness>) {
  seedSource(h.db);
  return h.receipts.accept({
    kind: 'connector_agent_request',
    requestId: 'request',
    sourceGeneration: 'generation-1',
    resumeToken: 'token',
  });
}
